/**
 * A LAZY Web `Response` for the bodies `c.text`/`c.json` build.
 *
 * Constructing an undici `Response` costs ~2us per call - measured at roughly a quarter of the whole
 * request budget on a small text response, and paid for an object the Node bridge never wants: it
 * writes a status, a header record, and the body bytes to the socket, which is exactly what the
 * handler already had. So on that runtime the two helpers hand back this stand-in. It satisfies the
 * `ResponseResult` protocol the bridge prefers over a `Response` (`toNodeBody` -> the direct socket
 * write, no `Response` built and no Web body stream drained), and it materializes the real thing only
 * if something actually reads the Web surface - a response hook, `app.fetch`, or user code touching
 * `.headers` - forwarding every member to it from then on. The prototype chains to the native
 * `Response`, so `instanceof Response` holds and each forwarded member runs with a genuine receiver.
 *
 * Only the Node bridge takes the `toNodeBody` shortcut; Bun and Deno hand a real `Response` to their
 * native server, so `request-context` builds this stand-in on Node alone.
 */

import { markTaggedResponse } from "./respond.ts"
import { RESPONSE_RESULT, type ResponseResult } from "./runtime-core.ts"

/** The direct-write shape: what {@link ResponseResult.toNodeBody} hands the Node adapter. */
interface NodeBodyView {
  readonly status: number
  readonly headers: Record<string, string>
  readonly body: string
}

const LazyResponse = /* @__PURE__ */ (() => {
  const NativeResponse = globalThis.Response

  class LazyResponse {
    #body: string
    #status: number
    /** Lowercase names, and owned by this response alone - the Node writer mutates the record in
     * place to declare `content-length`, so a shared or frozen one would be corrupted or throw. */
    #headers: Record<string, string>
    #real: Response | undefined

    constructor(body: string, status: number, headers: Record<string, string>) {
      this.#body = body
      this.#status = status
      this.#headers = headers
    }

    get status(): number {
      return this.#status
    }

    /** The real `Response`, built on first demand and tagged: a consumer that only needed the object
     * (a hook reading `.headers`) still reaches the Node writer without a body drain. */
    get _real(): Response {
      this.#real ??= markTaggedResponse(
        new NativeResponse(this.#body, { status: this.#status, headers: this.#headers }),
        this.#body,
      )
      return this.#real
    }

    toResponse(): Response {
      return this._real
    }

    /** `undefined` once the real `Response` exists: from then on it is the source of truth (a hook may
     * have mutated its headers), and the caller falls back to reading the tagged body off it. */
    toNodeBody(): NodeBodyView | undefined {
      return this.#real === undefined
        ? { status: this.#status, headers: this.#headers, body: this.#body }
        : undefined
    }
  }

  // Forward every other Response member to the lazily materialized real response. Data properties
  // (e.g. Symbol.toStringTag) are reachable through the chained prototype without a brand check, so
  // only accessors and methods need explicit forwarding.
  const own = new Set<string | symbol>([
    "constructor",
    "status",
    "_real",
    "toResponse",
    "toNodeBody",
  ])
  const keys: Array<string | symbol> = [
    ...Object.getOwnPropertyNames(NativeResponse.prototype),
    ...Object.getOwnPropertySymbols(NativeResponse.prototype),
  ]
  for (const key of keys) {
    if (own.has(key)) continue
    const descriptor = Object.getOwnPropertyDescriptor(NativeResponse.prototype, key)
    if (descriptor === undefined) continue
    if (typeof descriptor.value === "function") {
      Object.defineProperty(LazyResponse.prototype, key, {
        configurable: true,
        writable: true,
        value: function (this: InstanceType<typeof LazyResponse>, ...args: unknown[]) {
          const real = this._real as unknown as Record<string | symbol, unknown>
          return (real[key] as (...a: unknown[]) => unknown).apply(real, args)
        },
      })
    } else if (descriptor.get !== undefined) {
      Object.defineProperty(LazyResponse.prototype, key, {
        configurable: true,
        get(this: InstanceType<typeof LazyResponse>) {
          return (this._real as unknown as Record<string | symbol, unknown>)[key]
        },
      })
    }
  }
  // On the prototype, not a class field: the protocol mark is the same for every instance, and a
  // per-instance write would give back part of what deferring the `Response` just saved.
  Object.defineProperty(LazyResponse.prototype, RESPONSE_RESULT, { value: true })
  Object.setPrototypeOf(LazyResponse.prototype, NativeResponse.prototype)
  return LazyResponse
})()

/**
 * A `Response`-shaped value carrying `body` verbatim, deferring the undici `Response` until read.
 * `headers` MUST be a record this response can own (fresh per call, lowercase names).
 */
export function lazyResponse(
  body: string,
  status: number,
  headers: Record<string, string>,
): Response {
  return new LazyResponse(body, status, headers) as unknown as Response & ResponseResult
}
