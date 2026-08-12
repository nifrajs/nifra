/**
 * AWS Lambda adapter for nifra - runs an app behind API Gateway HTTP APIs (payload format v2) and
 * Lambda Function URLs (the same v2 shape), buffered via {@link handle} or streamed via
 * {@link streamHandle}. REST APIs (payload v1) and ALB events are out of scope.
 *
 * Security posture, by construction:
 * - Request headers are assembled from the event in exactly one place ({@link requestHeaders}):
 *   the `headers` map plus the separate `cookies` array. There is no second merge site, and the
 *   `cookies` array is canonical - a `cookie` key smuggled into `headers` never reaches the app.
 * - The body is decoded first (base64 or UTF-8) and its real `byteLength` checked against
 *   `maxBodyBytes` *before* a `Request` is constructed. The event's own claims about length -
 *   `content-length` or the encoded size - are never trusted.
 * - Response `isBase64Encoded` is decided by what the bytes actually are (strict UTF-8 decode),
 *   never by content-type guessing.
 * - Uncaught errors become the same flat `internal_error` 500 as every other nifra runtime; the
 *   event is never echoed.
 *
 * The adapter is dependency-free: it accepts anything with a fetch-shaped `fetch` method and
 * declares the Lambda event/`awslambda` shapes structurally.
 */

/** Platform fields the adapter feeds into `app.fetch` (mirrors nifra core's `Platform`). */
export interface LambdaPlatform {
  readonly env: LambdaEnv
  readonly clientIp?: string | undefined
  readonly waitUntil?: (promise: Promise<unknown>) => void
}

/** Anything with a fetch-shaped entry point - a nifra `server()` app satisfies this. */
export interface FetchHandler {
  fetch(request: Request, platform?: LambdaPlatform): Response | Promise<Response>
}

/**
 * The slice of an API Gateway HTTP API / Function URL payload-v2 event the adapter reads.
 * Extra fields pass through untouched on `c.env.event`.
 */
export interface LambdaEvent {
  readonly rawPath?: string
  readonly rawQueryString?: string
  readonly headers?: Readonly<Record<string, string | undefined>>
  /** Payload v2 delivers cookies here, not in `headers` - this array is the canonical source. */
  readonly cookies?: readonly string[]
  readonly body?: string | null
  readonly isBase64Encoded?: boolean
  readonly requestContext?: {
    readonly domainName?: string
    readonly http?: {
      readonly method?: string
      readonly sourceIp?: string
    }
  }
}

/** The Lambda invocation context. The adapter only forwards it; declare fields structurally. */
export interface LambdaContext {
  readonly awsRequestId?: string
  readonly functionName?: string
  readonly [key: string]: unknown
}

/** What handlers see as `c.env` (declare your app as `server<LambdaEnv>()` for typed access). */
export interface LambdaEnv {
  readonly event: LambdaEvent
  readonly context: LambdaContext | undefined
}

/** A payload-v2 result object, as API Gateway and Function URLs consume it. */
export interface LambdaResult {
  statusCode: number
  headers: Record<string, string>
  /** `Set-Cookie` values travel here (payload v2), one entry per cookie - never comma-joined. */
  cookies?: string[]
  body: string
  isBase64Encoded: boolean
}

export interface LambdaOptions {
  /**
   * Reject request bodies whose *decoded* size exceeds this many bytes with a flat 413 before a
   * `Request` is constructed. Defaults to 1,000,000 (nifra core's default). Set it to match your
   * app's `maxBodyBytes` if you customized that.
   */
  readonly maxBodyBytes?: number
}

/** The Node `Writable`-shaped stream Lambda hands a streaming handler. Declared structurally. */
export interface ResponseStream {
  write(chunk: Uint8Array | string): unknown
  end(): unknown
  once?(event: string, listener: () => void): unknown
}

interface StreamMetadata {
  statusCode: number
  headers: Record<string, string>
  cookies?: string[]
}

/** The `awslambda` global the managed Node runtime injects for response streaming. */
interface AwsLambdaGlobal {
  streamifyResponse(
    handler: (
      event: LambdaEvent,
      responseStream: ResponseStream,
      context?: LambdaContext,
    ) => Promise<void>,
  ): (event: LambdaEvent, responseStream: ResponseStream, context?: LambdaContext) => Promise<void>
  HttpResponseStream: {
    from(stream: ResponseStream, metadata: StreamMetadata): ResponseStream
  }
}

const DEFAULT_MAX_BODY_BYTES = 1_000_000
const assertBodyLimit = (value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError("maxBodyBytes must be a non-negative safe integer")
}

const TEXT_ENCODER = new TextEncoder()
// `fatal` makes invalid UTF-8 throw (the base64 signal); `ignoreBOM` keeps a leading BOM in the
// decoded string so a clean decode always re-encodes byte-identically - the honesty invariant.
const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

interface BufferLike {
  from(data: string, encoding: string): Uint8Array
  from(data: Uint8Array): { toString(encoding: string): string }
}

const nodeBuffer = (globalThis as { Buffer?: BufferLike }).Buffer

const fromBase64 = (data: string): Uint8Array => {
  if (nodeBuffer !== undefined) return nodeBuffer.from(data, "base64")
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

const toBase64 = (bytes: Uint8Array): string => {
  if (nodeBuffer !== undefined) return nodeBuffer.from(bytes).toString("base64")
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/**
 * The single place request headers come from. Payload v2 pre-joins repeated headers with commas in
 * `headers` and moves cookies into the `cookies` array; that array is set last, unconditionally,
 * so it is canonical even against an event that (out of spec) also carries a `cookie` header.
 */
const requestHeaders = (event: LambdaEvent): Headers => {
  const headers = new Headers()
  if (event.headers !== undefined) {
    for (const [name, value] of Object.entries(event.headers)) {
      if (value !== undefined) headers.set(name, value)
    }
  }
  if (event.cookies !== undefined && event.cookies.length > 0) {
    headers.set("cookie", event.cookies.join("; "))
  } else {
    headers.delete("cookie")
  }
  return headers
}

const flatError = (status: number, code: string): Response =>
  new Response(`{"ok":false,"error":"${code}"}`, {
    status,
    headers: { "content-type": "application/json" },
  })

/**
 * Build the `Request`, or a flat error `Response` when the event must be rejected before the app
 * runs. The body is decoded and measured first - a 413 here means no `Request` ever existed.
 */
const toRequest = (event: LambdaEvent, maxBodyBytes: number): Request | Response => {
  const method = event.requestContext?.http?.method ?? "GET"
  const headers = requestHeaders(event)
  const authority = event.requestContext?.domainName ?? headers.get("host") ?? "localhost"
  const path = event.rawPath !== undefined && event.rawPath !== "" ? event.rawPath : "/"
  const query =
    event.rawQueryString !== undefined && event.rawQueryString !== ""
      ? `?${event.rawQueryString}`
      : ""
  const url = `https://${authority}${path}${query}`

  let body: Uint8Array | undefined
  if (event.body !== undefined && event.body !== null && method !== "GET" && method !== "HEAD") {
    body = event.isBase64Encoded === true ? fromBase64(event.body) : TEXT_ENCODER.encode(event.body)
    if (body.byteLength > maxBodyBytes) return flatError(413, "payload_too_large")
  }

  return body === undefined
    ? new Request(url, { method, headers })
    : new Request(url, { method, headers, body })
}

/**
 * Response headers as a plain object for the v2 result, with `set-cookie` split out into the
 * `cookies` array (comma-joining cookies corrupts them) and `content-length` dropped - the
 * transport owns framing, and a stale length from before base64 re-encoding must not survive.
 */
const resultHeaders = (
  response: Response,
): { headers: Record<string, string>; cookies: string[] } => {
  const headers: Record<string, string> = {}
  for (const [name, value] of response.headers) {
    if (name === "set-cookie" || name === "content-length") continue
    headers[name] = value
  }
  return { headers, cookies: response.headers.getSetCookie() }
}

const toResult = async (response: Response): Promise<LambdaResult> => {
  const { headers, cookies } = resultHeaders(response)
  const bytes = new Uint8Array(await response.arrayBuffer())
  let body: string
  let isBase64Encoded: boolean
  try {
    body = UTF8_STRICT.decode(bytes)
    isBase64Encoded = false
  } catch {
    body = toBase64(bytes)
    isBase64Encoded = true
  }
  const result: LambdaResult = { statusCode: response.status, headers, body, isBase64Encoded }
  if (cookies.length > 0) result.cookies = cookies
  return result
}

const INTERNAL_ERROR = (): Response => flatError(500, "internal_error")

interface Invocation {
  response: Response
  pending: readonly Promise<unknown>[]
}

/** Run the app for one event. Never throws: failures collapse to the flat 500. */
const invoke = async (
  app: FetchHandler,
  event: LambdaEvent,
  context: LambdaContext | undefined,
  maxBodyBytes: number,
): Promise<Invocation> => {
  const pending: Promise<unknown>[] = []
  try {
    const built = toRequest(event, maxBodyBytes)
    if (built instanceof Response) return { response: built, pending }
    const response = await app.fetch(built, {
      env: { event, context },
      clientIp: event.requestContext?.http?.sourceIp,
      waitUntil: (promise) => {
        pending.push(promise)
      },
    })
    return { response, pending }
  } catch {
    return { response: INTERNAL_ERROR(), pending }
  }
}

// Background work must settle before the handler returns - Lambda freezes the container the
// moment it does, so a fire-and-forget promise would silently stall until (maybe) the next
// invocation thaws it. `allSettled` so a failed background task cannot corrupt the response.
const settle = (pending: readonly Promise<unknown>[]): Promise<unknown> | undefined =>
  pending.length > 0 ? Promise.allSettled(pending) : undefined

/**
 * A buffered Lambda handler for API Gateway HTTP APIs (payload v2) and Function URLs.
 *
 * ```ts
 * import { handle } from "@nifrajs/aws-lambda"
 * import { app } from "./app.ts" // built once per container, at module scope
 *
 * export const handler = handle(app)
 * ```
 */
export function handle(
  app: FetchHandler,
  options: LambdaOptions = {},
): (event: LambdaEvent, context?: LambdaContext) => Promise<LambdaResult> {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  assertBodyLimit(maxBodyBytes)
  return async (event, context) => {
    const { response, pending } = await invoke(app, event, context, maxBodyBytes)
    try {
      const result = await toResult(response)
      await settle(pending)
      return result
    } catch {
      await settle(pending)
      return {
        statusCode: 500,
        headers: { "content-type": "application/json" },
        body: '{"ok":false,"error":"internal_error"}',
        isBase64Encoded: false,
      }
    }
  }
}

/**
 * A streaming Lambda handler for Function URLs with `InvokeMode: RESPONSE_STREAM`, via the
 * runtime's `awslambda.streamifyResponse`. Response bytes flow as the app produces them - no
 * buffering, no base64. Requires the managed AWS Lambda Node runtime (the `awslambda` global);
 * API Gateway does not support response streaming - use {@link handle} there.
 */
export function streamHandle(
  app: FetchHandler,
  options: LambdaOptions = {},
): (event: LambdaEvent, responseStream: ResponseStream, context?: LambdaContext) => Promise<void> {
  const awslambda = (globalThis as { awslambda?: AwsLambdaGlobal }).awslambda
  if (awslambda === undefined) {
    throw new Error(
      "[nifra/aws-lambda] streamHandle requires the AWS Lambda Node runtime (no `awslambda` global found) - use handle() elsewhere",
    )
  }
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  assertBodyLimit(maxBodyBytes)
  return awslambda.streamifyResponse(async (event, responseStream, context) => {
    const { response, pending } = await invoke(app, event, context, maxBodyBytes)
    const { headers, cookies } = resultHeaders(response)
    const metadata: StreamMetadata = { statusCode: response.status, headers }
    if (cookies.length > 0) metadata.cookies = cookies
    const out = awslambda.HttpResponseStream.from(responseStream, metadata)
    try {
      if (response.body !== null) {
        for await (const chunk of response.body) {
          if (out.write(chunk) === false && typeof out.once === "function") {
            await new Promise<void>((resolve) => {
              ;(out.once as (event: string, listener: () => void) => unknown)("drain", resolve)
            })
          }
        }
      }
    } finally {
      // Headers are already on the wire once `from` returns; on a mid-stream failure the only
      // honest move left is to end the stream - never to emit a second response.
      out.end()
      await settle(pending)
    }
  })
}
