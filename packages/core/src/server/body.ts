/**
 * Bounded request-body reading - the single source of truth for nifra's body-size cap. A lying or
 * absent `Content-Length` can't force us to buffer an oversized payload: a declared length over the
 * cap is rejected *before* buffering, a chunked / length-less body is aborted mid-stream once the
 * running byte count exceeds the cap, and the fast path re-checks the real byte count after the
 * read - the declared length is a hint, never the enforcement. Shared by the server's schema path,
 * `c.boundedBody`, and `verifyWebhook` so they all enforce the same guarantee.
 */

import { jsonError } from "./http.ts"

interface BodySource {
  readonly headers: Pick<Headers, "get">
  readonly body: ReadableStream<Uint8Array> | null
  arrayBuffer(): Promise<ArrayBuffer>
  bytes?(): Promise<Uint8Array>
}

/** The pre-cap reader surface a transport-capped request stashes under {@link RAW_BODY_READERS}. */
export interface RawBodyReaders {
  readonly headers: Pick<Headers, "get">
  readonly body: ReadableStream<Uint8Array> | null
  arrayBuffer(): Promise<ArrayBuffer>
  /** Runtime-native exact-byte reader, when the request implementation exposes one. */
  bytes?(): Promise<Uint8Array>
  json(): Promise<unknown>
}

/**
 * The raw readers of a transport-capped request (see {@link capTransportBodyReads}), or the source
 * itself when it was never capped. Framework readers (the schema lane, `c.boundedBody`,
 * `verifyWebhook`, the idempotency lane) read through this so the transport cap on *direct* user
 * reads never narrows their own caller-supplied cap - `c.boundedBody(explicitBytes)` must keep
 * overriding the route cap upward, exactly as before the transport cap existed.
 */
export function rawBodySourceOf<T extends BodySource>(req: T): T {
  return ((req as { [RAW_BODY_READERS]?: T })[RAW_BODY_READERS] as T | undefined) ?? req
}

/** Security/resource limits must be finite byte counts. Invalid values otherwise make `> maxBytes`
 * comparisons fail open (notably for `NaN`) and can re-enable unbounded buffering. */
export function assertByteLimit(value: number, name = "maxBytes"): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`)
  }
}

export function parseContentLength(value: string): number | undefined {
  if (value.length === 0) return undefined
  let length = 0
  for (let i = 0; i < value.length; i++) {
    const digit = value.charCodeAt(i) - 48
    if (digit < 0 || digit > 9) return undefined
    length = length * 10 + digit
    if (length > Number.MAX_SAFE_INTEGER) return Number.POSITIVE_INFINITY
  }
  return length
}

/** The shared streaming byte-cap loop: read until done, or cancel + 413 once over `maxBytes`.
 * A single-chunk body (the common case for small chunked payloads) returns the runtime's own
 * chunk directly - no chunk array, no copy-merge. */
export async function drainCapped(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; status: 413 }> {
  assertByteLimit(maxBytes)
  const reader = body.getReader()
  let first: Uint8Array | undefined
  let rest: Uint8Array[] | undefined
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      return { ok: false, status: 413 }
    }
    if (first === undefined) {
      first = value
    } else {
      rest ??= []
      rest.push(value)
    }
  }
  if (rest === undefined) return { ok: true, bytes: first ?? new Uint8Array(0) }
  const merged = new Uint8Array(total)
  merged.set(first as Uint8Array, 0)
  let offset = (first as Uint8Array).byteLength
  for (const chunk of rest) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { ok: true, bytes: merged }
}

/**
 * Read a request body as **bytes**, capped at `maxBytes`. Rejects a `Content-Length` over the cap
 * before buffering (`413`) and a malformed `Content-Length` (`400`); a chunked / length-less body
 * falls through to the streaming byte-cap guard. Fast path: a non-chunked request with a
 * `Content-Length` within the cap is read via native `arrayBuffer()`, then the **real** byte count
 * is checked against the declared length - a source that delivers more than it declared (a lying
 * or upstream-decoding adapter) is rejected with `413` even though its header passed the hint.
 */
export async function readBoundedBytes(
  source: BodySource,
  maxBytes: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; status: 400 | 413 }> {
  assertByteLimit(maxBytes)
  const req = rawBodySourceOf(source)
  const declared = req.headers.get("content-length")
  if (declared !== null) {
    // A present Content-Length must be a non-negative integer (HTTP grammar: `1*DIGIT`). A non-numeric
    // / negative / fractional value is malformed → 400, rather than falling through to the streaming
    // guard (an UPPER-bound cap only, so a lying SMALLER length would otherwise be read in full).
    const length = parseContentLength(declared)
    if (length === undefined) return { ok: false, status: 400 }
    if (length > maxBytes) return { ok: false, status: 413 }
    const chunked = req.headers.get("transfer-encoding") !== null
    if (!chunked) {
      const bytesReader = req.bytes
      const bytes =
        bytesReader === undefined
          ? new Uint8Array(await req.arrayBuffer())
          : await bytesReader.call(req)
      // Content-Length was the fast-reject hint, never the enforcement: a lying or buffering
      // source (an adapter that decoded/expanded the body upstream) can hand over more bytes
      // than it declared. `length <= maxBytes` held above, so one comparison seals the cap.
      if (bytes.byteLength > length) return { ok: false, status: 413 }
      return { ok: true, bytes }
    }
  }
  const body = req.body
  if (body === null) return { ok: true, bytes: new Uint8Array(0) }
  return drainCapped(body, maxBytes)
}

/** Key under which a transport-capped request stashes its {@link RawBodyReaders}. */
export const RAW_BODY_READERS = Symbol("nifra.body.rawReaders")

/**
 * Ingress mark for a request whose bytes a runtime HTTP parser already delimited - Bun's compiled
 * native route table, `Deno.serve`, or an edge runtime that hands its own `Request` through
 * untouched. For those the declared Content-Length IS the transport frame, so the JSON lane keeps
 * the runtime's fused decode+parse instead of copying the body out to count it.
 *
 * Everything unmarked - a hand-built `Request`, the in-process client, and above all an adapter
 * that REBUILDS a body from parts an attacker supplied (an event envelope carrying both a header
 * map and a payload) - stays on the delivered-byte check. That is the shape the cap actually
 * defends against: a `content-length` copied from the caller while the body was decoded to a
 * different size.
 *
 * Registered (`Symbol.for`) on purpose, matching `nifra.response.body`: `@nifrajs/deno` mirrors
 * core's types rather than importing them, so an adapter must be able to set this without taking a
 * dependency on core. Forging it needs in-process code execution, which could equally just call
 * `app.fetch` with any `Request` it likes - so the registry costs no ground the process didn't
 * already own.
 */
const TRUSTED_FRAMING = Symbol.for("nifra.body.trustedFraming")

/** Mark a request delivered straight from a runtime HTTP parser. */
export function markTrustedBodyFraming(source: object): void {
  ;(source as { [TRUSTED_FRAMING]?: true })[TRUSTED_FRAMING] = true
}

/** True only for the runtime-framed ingress mark. */
export function hasTrustedBodyFraming(source: object): boolean {
  return (source as { [TRUSTED_FRAMING]?: true })[TRUSTED_FRAMING] === true
}

/** A capped request/source is capped exactly once; re-entry is a no-op. */
const TRANSPORT_CAPPED = new WeakSet<object>()

const CAP_DECODER = new TextDecoder()

/** Key under which the dispatcher marks a source with its route's transport byte cap. */
const TRANSPORT_CAP = Symbol("nifra.body.transportCap")

/** The transport cap's over-cap rejection: the flat error a shadowed direct reader throws (and the
 * capped `body` stream errors with). The lifecycle already treats a thrown `Response` as control
 * flow (the `c.boundedBody` contract), so an over-cap direct read answers 413 like every other cap. */
function transportCapError(status: 400 | 413): Response {
  return jsonError(status, status === 413 ? "payload_too_large" : "invalid_content_length")
}

/** First matching own-or-inherited descriptor, so instance shadows and prototype accessors both resolve. */
function descriptorOf(target: object, key: string): PropertyDescriptor | undefined {
  let current: object | null = target
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key)
    if (descriptor !== undefined) return descriptor
    current = Object.getPrototypeOf(current) as object | null
  }
  return undefined
}

/** An `ArrayBuffer` spanning exactly `bytes`, without a copy when the view already owns its buffer. */
function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? (bytes.buffer as ArrayBuffer)
    : (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
}

/** A pass-through stream that errors (with `reject(413)`) once more than `maxBytes` flow through. */
function cappedStreamOf(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  reject: (status: 400 | 413) => unknown,
): ReadableStream<Uint8Array> {
  // The reader is acquired on first pull, and `highWaterMark: 0` defers that first pull until a
  // consumer actually reads (the default of 1 pulls eagerly at construction): merely *accessing*
  // the capped `body` getter must not lock the raw stream (native semantics - only reading
  // consumes the body).
  // Typed structurally: the runtimes' lib typings disagree on the reader's shape (Bun's `readMany`,
  // Node's BYOB `read(view)` overload), and only `read`/`cancel` are used here.
  interface CappedReader {
    read(): Promise<{ done: false; value: Uint8Array } | { done: true; value?: undefined }>
    cancel(reason?: unknown): Promise<void>
  }
  let reader: CappedReader | undefined
  let total = 0
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        reader ??= body.getReader() as unknown as CappedReader
        const active = reader
        const { done, value } = await active.read()
        if (done) {
          controller.close()
          return
        }
        total += value.byteLength
        if (total > maxBytes) {
          await active.cancel().catch(() => {})
          controller.error(reject(413))
          return
        }
        controller.enqueue(value)
      },
      cancel(reason) {
        return reader === undefined ? body.cancel(reason) : reader.cancel(reason)
      },
    },
    { highWaterMark: 0 },
  )
}

/**
 * Shadow a request's direct body readers (`arrayBuffer`/`json`/`text`/`blob`/`bytes`/`formData`,
 * the `body` stream, and `clone`) with byte-capped versions, **on the same object** - the request's
 * identity is never swapped, so `WeakMap` keys, symbol stashes (the transport-codec lane's
 * pre-decoded body), and hook-observed references all survive. Nothing is read eagerly: the cap
 * only pays when user code actually reads, and framework readers bypass it through
 * {@link rawBodySourceOf} (stashed under {@link RAW_BODY_READERS}) to enforce their own caps.
 * An over-cap read rejects with `reject(413)` (a lying `Content-Length` with `reject(400)`), which
 * the lifecycle already treats as control flow - the same contract as `c.boundedBody`.
 */
/** The request's own pre-shadow readers - the fallback surface when the source offers none. */
function requestBodyReaders(request: Request): RawBodyReaders {
  const bodyDescriptor = descriptorOf(request, "body")
  const raw: RawBodyReaders = {
    get headers() {
      return request.headers
    },
    get body() {
      return (
        bodyDescriptor?.get !== undefined
          ? bodyDescriptor.get.call(request)
          : (bodyDescriptor?.value ?? null)
      ) as ReadableStream<Uint8Array> | null
    },
    arrayBuffer: request.arrayBuffer.bind(request),
    json: request.json.bind(request),
  }
  if (typeof request.bytes === "function") raw.bytes = request.bytes.bind(request)
  return raw
}

function capRequestBodyReads(request: Request, maxBytes: number, preset?: RawBodyReaders): void {
  if (TRANSPORT_CAPPED.has(request)) return
  TRANSPORT_CAPPED.add(request)
  const reject = transportCapError
  const raw = preset ?? requestBodyReaders(request)
  // One bounded buffer backs every shadowed reader; a second read replays it instead of failing
  // with "body already used" (a strict superset of the native one-shot contract).
  let buffered: Promise<Uint8Array> | undefined
  const cappedBytes = (): Promise<Uint8Array> =>
    (buffered ??= readBoundedBytes(raw, maxBytes).then((read) => {
      if (!read.ok) throw reject(read.status)
      return read.bytes
    }))
  // The reader methods live on the prototype as writable data properties, so a plain instance
  // assignment shadows them - materially cheaper than defineProperty on this per-read path. Only
  // `body` (a prototype accessor) needs defineProperty below.
  const shadowed = request as unknown as Record<string, unknown> & {
    [RAW_BODY_READERS]?: RawBodyReaders
  }
  shadowed[RAW_BODY_READERS] = raw
  shadowed.arrayBuffer = () => cappedBytes().then(exactArrayBuffer)
  shadowed.bytes = () => cappedBytes().then((bytes) => bytes.slice())
  shadowed.json = () =>
    cappedBytes().then((bytes) => JSON.parse(CAP_DECODER.decode(bytes)) as unknown)
  shadowed.text = () => cappedBytes().then((bytes) => CAP_DECODER.decode(bytes))
  shadowed.blob = () =>
    cappedBytes().then(
      (bytes) =>
        new Blob([exactArrayBuffer(bytes)], {
          type: request.headers.get("content-type") ?? "",
        }),
    )
  shadowed.formData = () =>
    cappedBytes().then((bytes) =>
      new Response(exactArrayBuffer(bytes), {
        headers: { "content-type": request.headers.get("content-type") ?? "" },
      }).formData(),
    )
  // `clone()` must not mint an uncapped escape hatch: the clone gets the same cap.
  if (typeof request.clone === "function") {
    // Node's lib typing returns undici's `Request` here; at runtime it's the same object shape.
    const rawClone = request.clone.bind(request) as () => Request
    shadowed.clone = () => {
      const clone = rawClone()
      capRequestBodyReads(clone, maxBytes)
      return clone
    }
  }
  let cappedBody: ReadableStream<Uint8Array> | null | undefined
  Object.defineProperty(request, "body", {
    configurable: true,
    get(): ReadableStream<Uint8Array> | null {
      if (cappedBody === undefined) {
        const rawBody = raw.body
        cappedBody = rawBody === null ? null : cappedStreamOf(rawBody, maxBytes, reject)
      }
      return cappedBody
    },
  })
}

/**
 * Mark a request source with its route's transport byte cap. Dispatch-time cost is one property
 * write; nothing is shadowed, wrapped, or read here - the hot path stays untouched. The cap is
 * applied by {@link applyTransportCap} only when user code actually reaches for the request
 * (`c.req` / `c.request`), so a route that never direct-reads the body pays nothing.
 */
export function markTransportCap(source: object, maxBytes: number): void {
  ;(source as { [TRANSPORT_CAP]?: number })[TRANSPORT_CAP] = maxBytes
}

/**
 * Enforce a marked source's transport byte cap on **direct user reads** of its request
 * (`c.req.json()`, `c.req.arrayBuffer()`, the raw `body` stream, `clone()`, ...), without swapping
 * the request's identity and without reading anything eagerly: the direct readers are shadowed with
 * byte-capped versions on the same object, so `WeakMap` keys, symbol stashes (the transport-codec
 * lane's pre-decoded body), and hook-observed references all survive. Framework readers bypass the
 * shadow through {@link rawBodySourceOf} and enforce their own caps - `c.boundedBody(explicit)`
 * still overrides in either direction. An unmarked source (`bodyLimit: "unlimited"`) is untouched.
 *
 * A source that owns its transport bytes directly (Node's lazy source reads the socket itself)
 * supplies them through `RequestSource.rawBodyReaders`: the capped readers then buffer off the
 * socket instead of routing every read back through a runtime `Request` the source was still
 * deferring. The cap is identical either way - the same {@link readBoundedBytes} enforces it.
 */
export function applyTransportCap(source: object, request: Request): void {
  const maxBytes = (source as { [TRANSPORT_CAP]?: number })[TRANSPORT_CAP]
  // The capped check comes BEFORE the body probe: post-cap, `request.body` is the shadowed getter,
  // and re-reading it on every `c.req` access would rebuild capped state for nothing.
  if (maxBytes === undefined || TRANSPORT_CAPPED.has(request)) return
  const provide = (source as { rawBodyReaders?: () => RawBodyReaders }).rawBodyReaders
  const preset = provide === undefined ? undefined : provide.call(source)
  // The null-body shortcut is only worth its probe when there is no cheaper surface: on a source
  // that defers its `Request`, reading `request.body` would materialize the very object the preset
  // readers exist to avoid. Capping a bodiless request costs nothing but the shadowing itself.
  if (preset === undefined && request.body === null) return
  capRequestBodyReads(request, maxBytes, preset)
  // A wrapper source (Node's lazy source) delegates its own body readers to the request once it
  // materializes - which are now the shadowed ones. Mirror the raw-reader stash onto the source so
  // framework readers (`rawBodySourceOf(source)`) keep reading pre-shadow there too.
  const raw = (request as unknown as { [RAW_BODY_READERS]?: RawBodyReaders })[RAW_BODY_READERS]
  if ((source as unknown) !== request && raw !== undefined) {
    ;(source as { [RAW_BODY_READERS]?: RawBodyReaders })[RAW_BODY_READERS] = raw
  }
}
