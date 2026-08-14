/**
 * The Node-stream escape hatch: a Web `ReadableStream` over a Node `Readable` that can hand the
 * Node stream back, so two adjacent Node-native layers do not have to round-trip bytes through Web
 * objects just because the contract between them is Web-shaped.
 *
 * Why this exists: `@nifrajs/node` receives a Node `IncomingMessage` and must present a Web
 * `Request`; `@nifrajs/proxy/undici` receives that `Request` and must hand undici a Node stream
 * again. Measured on a pinned-core Linux rig, that round trip - not hygiene, not routing, not the
 * adapter - is the entire remaining distance to `@fastify/reply-from`, which never leaves Node
 * streams: -17% on GET (one conversion) and -34% on POST (two, since the request body converts on
 * the way out as well).
 *
 * Why it cannot be `Readable.toWeb`: that consumes its source EAGERLY. Wrapping a `Readable` and
 * then never reading the wrapper still leaves the source read (`readableDidRead === true`), so
 * handing the raw stream onward afterwards loses the body outright. The wrapper here touches its
 * source only on the first `pull`, which is what makes the hand-back sound.
 *
 * The seam is a `Symbol.for` key because the two packages that use it share no runtime dependency
 * (`@nifrajs/proxy` is dependency-free by design, so it carries its own copy of this file). Both
 * sides must agree on {@link NODE_STREAM_CLAIM} and on the shape below, and nothing else.
 *
 * Claiming is ONE-SHOT and refused once the Web view has been touched, which is the property that
 * makes it safe: a body can never be split between the two views, and a layer that already started
 * reading the Web stream silently keeps the ordinary path instead of forwarding a truncated body.
 */

import { Readable } from "node:stream"

/** Shared with `@nifrajs/proxy/undici`'s copy of this module - the value is the contract. */
export const NODE_STREAM_CLAIM = Symbol.for("nifra.node.stream-claim")

interface NodeStreamClaim {
  /** The backing Node stream, or `null` if the Web view was already read, cancelled, or claimed. */
  claim(): Readable | null
}

type ClaimableStream = ReadableStream<Uint8Array> & {
  readonly [NODE_STREAM_CLAIM]?: NodeStreamClaim
}

/**
 * What cancelling the Web view should do to the Node stream under it.
 *
 * `"destroy"` releases the source immediately, which is what a response body wants: a client that
 * walked away from a file or an upstream response must not cost another byte of it.
 *
 * `"drain"` lets the source run to its own end and destroys it then, which is what a REQUEST body
 * wants, and is `Readable.toWeb`'s behaviour rather than a new policy. Destroying an
 * `IncomingMessage` destroys its socket, so cancelling a half-read upload synchronously tears the
 * connection down before the handler can answer - a body rejected by the size cap reaches the client
 * as a connection reset instead of the `413` that explains it. Draining leaves the socket writable
 * long enough for the response to go out. It does NOT mean reading the rest of a hostile upload:
 * once that response completes, Node destroys the socket itself because the request is incomplete,
 * so an over-cap body stops arriving within roughly the cap either way (measured: a 64 MB body
 * against a 1 MB cap transfers about 2 MB before the connection closes, on this path and on
 * `Readable.toWeb` alike).
 */
export type CancelPolicy = "destroy" | "drain"

/**
 * A Web view of `source` that defers to it lazily and can be traded back in for it.
 *
 * `highWaterMark: 0` keeps construction free of a speculative pull - a stream that is going to be
 * claimed must not have read a byte first.
 */
export function claimableWebStream(
  source: Readable,
  onCancel: CancelPolicy = "destroy",
): ReadableStream<Uint8Array> {
  let iterator: AsyncIterator<Buffer | Uint8Array> | undefined
  let surrendered = false

  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller): Promise<void> {
        if (surrendered) {
          // Unreachable through `claimNodeStream` (it refuses a locked stream and the claim is
          // one-shot), so reaching it means someone kept a reader across the hand-off. Fail loudly
          // rather than serve a body that is missing whatever the other consumer already took.
          const error = new Error(
            "[nifra] this request body was handed to a Node-native consumer; the Web stream over it can no longer be read",
          )
          controller.error(error)
          return Promise.reject(error)
        }
        iterator ??= source[Symbol.asyncIterator]() as AsyncIterator<Buffer | Uint8Array>
        return iterator.next().then(
          ({ done, value }) => {
            if (done === true) {
              controller.close()
              return
            }
            // `Buffer` is a `Uint8Array`, so a binary-mode stream needs no conversion. An
            // object-mode stream has no business being an HTTP body.
            if (!(value instanceof Uint8Array)) {
              throw new TypeError("[nifra] request body stream yielded a non-binary chunk")
            }
            controller.enqueue(value)
          },
          (error: unknown) => {
            controller.error(error)
            throw error
          },
        )
      },
      cancel(reason): void {
        if (surrendered) return
        surrendered = true
        const error = reason instanceof Error ? reason : undefined
        if (onCancel === "destroy" || source.destroyed) {
          source.destroy(error)
          return
        }
        // The source stays live after this returns, so it keeps the right to emit `error` - and an
        // unhandled `error` on a Node stream terminates the process. A client that resets the
        // connection mid-drain is an ordinary event here, not a fault worth propagating: the read
        // was already abandoned.
        source.on("error", () => {
          if (!source.destroyed) source.destroy()
        })
        // Both, because only one of them is reached: a source that runs out ends, and one whose
        // socket is torn down by the completed response closes without ending.
        source.once("end", () => source.destroy())
        source.once("close", () => source.destroy())
        source.resume()
      },
    },
    { highWaterMark: 0 },
  )

  const claim: NodeStreamClaim = {
    claim(): Readable | null {
      // `iterator !== undefined` means a pull already happened, so bytes are gone; `destroyed`
      // means there is nothing left to hand over.
      if (surrendered || iterator !== undefined || source.destroyed) return null
      surrendered = true
      return source
    },
  }
  Object.defineProperty(stream, NODE_STREAM_CLAIM, { value: claim, enumerable: false })
  return stream
}

/**
 * Trade a Web stream back for the Node stream underneath it, or `null` when that is not sound -
 * a foreign stream, one someone holds a reader on, or one that has already been read or claimed.
 * Every `null` means "use the ordinary Web path", never "fail".
 */
export function claimNodeStream(body: ReadableStream<Uint8Array> | null): Readable | null {
  if (body === null || body.locked) return null
  const holder = (body as ClaimableStream)[NODE_STREAM_CLAIM]
  if (holder === undefined || typeof holder.claim !== "function") return null
  const claimed = holder.claim()
  // A `Symbol.for` key is reachable by anything in the process, so the value is not taken on trust.
  return claimed instanceof Readable ? claimed : null
}
