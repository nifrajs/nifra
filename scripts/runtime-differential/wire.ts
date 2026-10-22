/**
 * Requests as bytes on a socket, and what came back.
 *
 * `fetch` normalizes a request before it sends it: it resolves dot segments, joins duplicate headers,
 * computes its own Content-Length and refuses a body on GET. Every one of those is a case the harness
 * has to send as written, so requests go out over a raw socket and the answer is parsed here.
 */
import { connect } from "node:net"

/** How the body is framed on the wire. `declared` sends `value` as the Content-Length, true or not. */
export type Framing =
  | { readonly kind: "length" }
  | { readonly kind: "none" }
  | { readonly kind: "chunked" }
  | { readonly kind: "declared"; readonly value: string }

export interface WireRequest {
  readonly method: string
  /** The request-target, byte for byte; non-ASCII is sent as UTF-8. */
  readonly target: string
  /** In order, duplicates kept. `Connection: close` is appended by the sender, never generated. */
  readonly headers: readonly (readonly [string, string])[]
  readonly body: string
  readonly framing: Framing
}

export type Outcome =
  | {
      readonly kind: "response"
      readonly status: number
      /** Lower-cased names, in the order received. */
      readonly headers: readonly (readonly [string, string])[]
      readonly body: Uint8Array
    }
  /** The connection ended before any response byte. */
  | { readonly kind: "closed"; readonly detail: string }
  /** No complete response before the deadline. */
  | { readonly kind: "timeout"; readonly received: number }
  | { readonly kind: "malformed-response"; readonly raw: string }
  /** The in-process lane cannot build a `Request` for these bytes. */
  | { readonly kind: "unrepresentable"; readonly reason: string }

const encoder = new TextEncoder()

/**
 * The body is all there: the declared Content-Length is no larger than what is sent, and no extra
 * `Transfer-Encoding` header promises chunks the framing does not send.
 */
export function deliversWholeBody(request: WireRequest): boolean {
  if (
    request.framing.kind !== "chunked" &&
    request.headers.some(([name]) => name.toLowerCase() === "transfer-encoding")
  )
    return false
  if (request.framing.kind !== "declared") return true
  const declared = Number(request.framing.value)
  return Number.isSafeInteger(declared) && declared <= encoder.encode(request.body).length
}

export function encodeRequest(request: WireRequest): Uint8Array {
  const body = encoder.encode(request.body)
  const lines = [`${request.method} ${request.target} HTTP/1.1`]
  for (const [name, value] of request.headers) lines.push(`${name}: ${value}`)
  const framing = request.framing
  if (framing.kind === "length") lines.push(`Content-Length: ${body.length}`)
  else if (framing.kind === "declared") lines.push(`Content-Length: ${framing.value}`)
  else if (framing.kind === "chunked") lines.push("Transfer-Encoding: chunked")
  lines.push("Connection: close")
  const head = encoder.encode(`${lines.join("\r\n")}\r\n\r\n`)
  let payload: Uint8Array = body
  if (framing.kind === "chunked") {
    payload =
      body.length === 0
        ? encoder.encode("0\r\n\r\n")
        : concat([
            encoder.encode(`${body.length.toString(16)}\r\n`),
            body,
            encoder.encode("\r\n0\r\n\r\n"),
          ])
  }
  return concat([head, payload])
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let size = 0
  for (const part of parts) size += part.length
  const out = new Uint8Array(size)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** A promise opened once from outside. */
export interface Gate<T> {
  readonly promise: Promise<T>
  open(value: T): void
}

export function gate<T>(): Gate<T> {
  let open!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

/**
 * Race `work` against a deadline gate. The timer only opens the gate: nothing waits on wall-clock time
 * unless the work under test never finishes, and then the harness reports a hang rather than sleeping.
 */
export async function withDeadline<T>(
  work: Promise<T>,
  deadlineMs: number,
  onDeadline: () => T,
): Promise<T> {
  const deadline = gate<T>()
  const timer = setTimeout(() => deadline.open(onDeadline()), deadlineMs)
  try {
    return await Promise.race([work, deadline.promise])
  } finally {
    clearTimeout(timer)
  }
}

interface Parsed {
  readonly status: number
  readonly headers: readonly (readonly [string, string])[]
  readonly body: Uint8Array
}

type ParseState =
  | { readonly kind: "incomplete" }
  | { readonly kind: "complete"; readonly response: Parsed }
  | { readonly kind: "malformed"; readonly reason: string }
  | { readonly kind: "interim-only" }

const CRLFCRLF = encoder.encode("\r\n\r\n")

function indexOf(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let at = from; at <= haystack.length - needle.length; at++) {
    for (let k = 0; k < needle.length; k++) if (haystack[at + k] !== needle[k]) continue outer
    return at
  }
  return -1
}

const latin1 = new TextDecoder("latin1")

/**
 * Parse the first final response in `bytes`. `ended` says the server closed the connection, which is
 * what delimits a body that has neither a length nor chunked framing.
 */
export function parseResponse(
  bytes: Uint8Array,
  requestMethod: string,
  ended: boolean,
): ParseState {
  let start = 0
  for (;;) {
    const split = indexOf(bytes, CRLFCRLF, start)
    if (split === -1) {
      if (!ended) return { kind: "incomplete" }
      // Only an interim `100 Continue` came before the close: no final answer, as if none came.
      return start > 0 && start === bytes.length
        ? { kind: "interim-only" }
        : { kind: "malformed", reason: "no response head" }
    }
    const lines = latin1.decode(bytes.subarray(start, split)).split("\r\n")
    const statusLine = /^HTTP\/1\.[01] (\d{3})(?: |$)/.exec(lines[0] ?? "")
    if (statusLine === null)
      return { kind: "malformed", reason: `status line ${JSON.stringify(lines[0])}` }
    const status = Number(statusLine[1])
    const headers: (readonly [string, string])[] = []
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(":")
      if (colon <= 0) return { kind: "malformed", reason: `header line ${JSON.stringify(line)}` }
      headers.push([line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()])
    }
    const bodyStart = split + 4
    // An interim 1xx (100 Continue) precedes the final response on the same connection.
    if (status >= 100 && status < 200) {
      start = bodyStart
      continue
    }
    const rest = bytes.subarray(bodyStart)
    if (requestMethod === "HEAD" || status === 204 || status === 304) {
      return { kind: "complete", response: { status, headers, body: new Uint8Array(0) } }
    }
    const transfer = headers.find(([name]) => name === "transfer-encoding")?.[1]
    if (transfer !== undefined && /chunked/i.test(transfer)) {
      const decoded = decodeChunked(rest)
      if (decoded === undefined)
        return ended
          ? { kind: "malformed", reason: "truncated chunked body" }
          : { kind: "incomplete" }
      return { kind: "complete", response: { status, headers, body: decoded } }
    }
    const length = headers.find(([name]) => name === "content-length")?.[1]
    if (length !== undefined) {
      const size = Number(length)
      if (!Number.isSafeInteger(size) || size < 0)
        return { kind: "malformed", reason: `content-length ${length}` }
      if (rest.length < size)
        return ended ? { kind: "malformed", reason: "truncated body" } : { kind: "incomplete" }
      return { kind: "complete", response: { status, headers, body: rest.slice(0, size) } }
    }
    return ended
      ? { kind: "complete", response: { status, headers, body: rest.slice() } }
      : { kind: "incomplete" }
  }
}

function decodeChunked(bytes: Uint8Array): Uint8Array | undefined {
  const parts: Uint8Array[] = []
  let at = 0
  for (;;) {
    const eol = indexOf(bytes, encoder.encode("\r\n"), at)
    if (eol === -1) return undefined
    const size = Number.parseInt(latin1.decode(bytes.subarray(at, eol)).split(";")[0] ?? "", 16)
    if (!Number.isFinite(size) || size < 0) return undefined
    if (size === 0) return concat(parts)
    if (bytes.length < eol + 2 + size + 2) return undefined
    parts.push(bytes.subarray(eol + 2, eol + 2 + size))
    at = eol + 2 + size + 2
  }
}

const CONNECT_ATTEMPTS = 3
const RETRYABLE_CONNECT = new Set(["ECONNREFUSED", "EADDRNOTAVAIL"])

/**
 * Send `request` to `127.0.0.1:port` and read the first final response. When the declared length
 * promises more body than is sent, the client half-closes after writing: a server that keeps waiting
 * for bytes that cannot come is then a hang, not a slow client.
 */
export function exchange(port: number, request: WireRequest, deadlineMs: number): Promise<Outcome> {
  const bytes = encodeRequest(request)
  let received = 0
  let socket: ReturnType<typeof connect> | undefined
  const work = new Promise<Outcome>((resolve) => {
    const chunks: Uint8Array[] = []
    let settled = false
    const settle = (outcome: Outcome) => {
      if (settled) return
      settled = true
      socket?.destroy()
      resolve(outcome)
    }
    const check = (ended: boolean, detail: string) => {
      const all = concat(chunks)
      if (all.length === 0) {
        if (ended) settle({ kind: "closed", detail })
        return
      }
      const state = parseResponse(all, request.method, ended)
      if (state.kind === "complete") settle({ kind: "response", ...state.response })
      else if (state.kind === "interim-only")
        settle({ kind: "closed", detail: `${detail} after 100 Continue` })
      else if (state.kind === "malformed")
        settle({
          kind: "malformed-response",
          raw: `${latin1.decode(all.subarray(0, 512))} (${state.reason})`,
        })
    }
    const open = (attempt: number) => {
      const current = connect({ port, host: "127.0.0.1" })
      socket = current
      let connected = false
      current.on("connect", () => {
        connected = true
        current.write(bytes)
        if (!deliversWholeBody(request)) current.end()
      })
      current.on("data", (chunk: Uint8Array) => {
        chunks.push(chunk)
        received += chunk.length
        check(false, "")
      })
      current.on("end", () => check(true, "end"))
      current.on("close", () => check(true, "close"))
      current.on("error", (error: NodeJS.ErrnoException) => {
        // Before a connection exists the request has not left this process, so a refusal is about
        // this machine's sockets (a 4-tuple still in TIME_WAIT after many runs), not the server.
        if (!connected && attempt < CONNECT_ATTEMPTS && RETRYABLE_CONNECT.has(error.code ?? "")) {
          current.removeAllListeners()
          current.destroy()
          open(attempt + 1)
          return
        }
        check(true, error.code ?? error.message)
      })
    }
    open(1)
  })
  return withDeadline(work, deadlineMs, () => {
    socket?.destroy()
    return { kind: "timeout", received }
  })
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * The same request as a `Request`, for the in-process lane - or why it cannot be one. A request that
 * only a socket can carry (a body on GET, a length that lies, a header `Headers` refuses) never
 * reaches a bare `app.fetch`, so that lane sits it out instead of reporting a difference.
 */
export function toRequest(request: WireRequest): Request | string {
  if (request.framing.kind === "declared") {
    const declared = Number(request.framing.value)
    if (
      String(declared) !== request.framing.value ||
      declared !== encoder.encode(request.body).length
    )
      return "declared length differs from the body"
  }
  if (request.framing.kind === "none" && request.body.length > 0) return "unframed body"
  if (request.headers.some(([name]) => name.toLowerCase() === "transfer-encoding"))
    return "explicit Transfer-Encoding header"
  if (/[^\x21-\x7e]/.test(request.target)) return "target has bytes a URL would re-encode"
  const hosts = request.headers.filter(([name]) => name.toLowerCase() === "host")
  if (hosts.length !== 1) return "not exactly one Host"
  // A runtime builds the URL from the Host; one that is not an authority has no URL to build.
  const host = hosts[0]?.[1] ?? ""
  if (
    !/^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i.test(host) ||
    !URL.canParse(`http://${host}/`)
  )
    return "Host is not an authority"
  let url: string
  try {
    // Origin-form is appended to the authority, never resolved against it: `//x` is a path, not a host.
    url = new URL(
      request.target.startsWith("/") ? `http://${host}${request.target}` : request.target,
    ).href
  } catch (error) {
    return `URL: ${messageOf(error)}`
  }
  const headers = new Headers()
  try {
    for (const [name, value] of request.headers) {
      if (
        name.toLowerCase() === "host" ||
        name.toLowerCase() === "content-length" ||
        name.toLowerCase() === "transfer-encoding"
      )
        continue
      // The wire carries a value's UTF-8 bytes; a runtime reads each byte as one character.
      headers.append(name, latin1.decode(encoder.encode(value)))
    }
  } catch (error) {
    return `Headers: ${messageOf(error)}`
  }
  const init: RequestInit = { method: request.method, headers }
  if (request.framing.kind !== "none") init.body = request.body
  let built: Request
  try {
    built = new Request(url, init)
  } catch (error) {
    return `Request: ${messageOf(error)}`
  }
  // Fetch upper-cases only the six standard methods and keeps any other token as written. Bun 1.4.3
  // turns a method it does not know (`FOO`, `PURGE`) into `GET`, which a socket never does.
  const standard = /^(?:delete|get|head|options|post|put)$/i.test(request.method)
  if (built.method !== (standard ? request.method.toUpperCase() : request.method)) {
    return `Request rewrote method ${request.method} to ${built.method}`
  }
  return built
}

/** Run one request through an in-process `fetch` handler, with the same deadline as a socket. */
export async function exchangeInProcess(
  handler: (request: Request) => Response | Promise<Response>,
  request: WireRequest,
  deadlineMs: number,
): Promise<Outcome> {
  const built = toRequest(request)
  if (typeof built === "string") return { kind: "unrepresentable", reason: built }
  const work = (async (): Promise<Outcome> => {
    const response = await handler(built)
    const headers: (readonly [string, string])[] = []
    response.headers.forEach((value, name) => {
      if (name !== "set-cookie") headers.push([name, value])
    })
    for (const cookie of response.headers.getSetCookie()) headers.push(["set-cookie", cookie])
    const body =
      request.method === "HEAD" || response.status === 204 || response.status === 304
        ? new Uint8Array(0)
        : new Uint8Array(await response.arrayBuffer())
    return { kind: "response", status: response.status, headers, body }
  })()
  return withDeadline(work, deadlineMs, () => ({ kind: "timeout", received: 0 }))
}
