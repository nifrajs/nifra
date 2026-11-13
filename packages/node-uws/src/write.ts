import { STATUS_CODES } from "node:http"
import type { NodeServeOutcome } from "@nifrajs/node/transport"
import type { UwsSource } from "./source.ts"
import type { HttpResponse } from "./uws.ts"

type HeaderRecord = Readonly<Record<string, string | readonly string[]>>

const JSON_CONTENT_TYPE = Response.json(0).headers.get("content-type") ?? "application/json"
export const INTERNAL_ERROR_BODY = '{"ok":false,"error":"internal_error"}'

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const BAD_VALUE = /[^\t\x20-\x7e\x80-\xff]/

const STATUS_LINES = new Map<number, string>()
function statusLine(status: number): string {
  let line = STATUS_LINES.get(status)
  if (line === undefined) {
    if (!Number.isInteger(status) || status < 100 || status > 999) {
      throw new RangeError(`Invalid status code: ${String(status)}`)
    }
    line = `${status} ${STATUS_CODES[status] ?? "Unknown"}`
    STATUS_LINES.set(status, line)
  }
  return line
}

// An enumerable property on Object.prototype must never become a response header.
const hasOwn = Object.hasOwn
// Null-prototype records (what the core builds) cannot inherit anything, so they skip the per-key check.
const inherits = (record: object): boolean => Object.getPrototypeOf(record) !== null

const checkedNames = new Set<string>()
function checkName(name: string): void {
  if (checkedNames.has(name)) return
  if (!TOKEN.test(name)) throw new TypeError("Invalid character in header name")
  if (checkedNames.size >= 512) checkedNames.clear()
  checkedNames.add(name)
}

const lastChecked = new Map<string, string>()
function checkValue(value: string): void {
  if (BAD_VALUE.test(value)) throw new TypeError("Invalid character in header content")
}

/** Names uWS frames itself: a copy from the app would double the header on the wire. */
function owned(name: string): boolean {
  switch (name.length) {
    case 4:
      return name === "date" || name.toLowerCase() === "date"
    case 14:
      return name === "content-length" || name.toLowerCase() === "content-length"
    case 17:
      return name === "transfer-encoding" || name.toLowerCase() === "transfer-encoding"
    default:
      return false
  }
}

/**
 * Everything that can make a header or status unwritable, checked before the first byte is. uWS
 * writes what it is given, where Node's `writeHead` throws on a CR/LF in a value, so the check
 * belongs here: a throw halfway through a corked write would leave a response nothing can finish.
 */
function validate(
  status: number,
  headers: HeaderRecord | undefined,
  cookies: readonly string[] | undefined,
): void {
  statusLine(status)
  if (headers !== undefined) {
    const guard = inherits(headers)
    for (const name in headers) {
      if (guard && !hasOwn(headers, name)) continue
      const value = headers[name]
      if (typeof value === "string") {
        // The same string as the last one that passed under this name needs no second look.
        if (lastChecked.get(name) === value) continue
        checkName(name)
        checkValue(value)
        if (lastChecked.size >= 512) lastChecked.clear()
        lastChecked.set(name, value)
      } else {
        checkName(name)
        if (value !== undefined) for (const each of value) checkValue(each)
      }
    }
  }
  if (cookies !== undefined) for (const cookie of cookies) checkValue(cookie)
}

/** Whether a `Content-Type` header is present, written as the record is emitted. */
function emitHeaders(
  res: HttpResponse,
  headers: HeaderRecord | undefined,
  cookies: readonly string[] | undefined,
  defaultType: string | undefined,
): void {
  let typed = false
  if (headers !== undefined) {
    const guard = inherits(headers)
    for (const name in headers) {
      if ((guard && !hasOwn(headers, name)) || owned(name)) continue
      if (!typed && name.length === 12 && name.toLowerCase() === "content-type") typed = true
      const value = headers[name]
      if (typeof value === "string") res.writeHeader(name, value)
      else if (value !== undefined) for (const each of value) res.writeHeader(name, each)
    }
  }
  if (!typed && defaultType !== undefined) res.writeHeader("content-type", defaultType)
  if (cookies !== undefined) for (const cookie of cookies) res.writeHeader("set-cookie", cookie)
}

const isBodyless = (status: number): boolean => status === 204 || status === 205 || status === 304

const byteLengthOf = (body: string | Uint8Array): number =>
  typeof body === "string" ? Buffer.byteLength(body) : body.byteLength

function declaredLength(headers: HeaderRecord | undefined): number | undefined {
  if (headers === undefined) return undefined
  for (const name in headers) {
    if (name.length !== 14 || !hasOwn(headers, name) || name.toLowerCase() !== "content-length")
      continue
    const value = headers[name]
    const text = typeof value === "string" ? value : value?.[0]
    if (text === undefined || !/^\d{1,15}$/.test(text)) return undefined
    return Number(text)
  }
  return undefined
}

function emitBuffered(
  res: HttpResponse,
  status: number,
  headers: HeaderRecord | undefined,
  cookies: readonly string[] | undefined,
  body: string | Uint8Array | null,
  isHead: boolean,
  defaultType: string | undefined,
  headLength: number | undefined,
): void {
  const bodyless = isBodyless(status)
  res.writeStatus(statusLine(status))
  emitHeaders(res, headers, cookies, bodyless || body === null ? undefined : defaultType)
  if (bodyless) res.endWithoutBody()
  else if (isHead) res.endWithoutBody(headLength ?? (body === null ? 0 : byteLengthOf(body)))
  else if (body === null) res.end()
  else res.end(body)
}

/**
 * A buffered answer: status, headers, and the whole body (or none) in one write. `inHandler` is true
 * while still inside uWS's route callback, where the socket is already corked; anywhere else the write
 * is corked here.
 */
function writeBuffered(
  res: HttpResponse,
  source: UwsSource,
  status: number,
  headers: HeaderRecord | undefined,
  cookies: readonly string[] | undefined,
  body: string | Uint8Array | null,
  isHead: boolean,
  defaultType: string | undefined,
  inHandler: boolean,
  headLength?: number,
): void {
  validate(status, headers, cookies)
  if (inHandler) {
    emitBuffered(res, status, headers, cookies, body, isHead, defaultType, headLength)
  } else {
    res.cork(() => {
      emitBuffered(res, status, headers, cookies, body, isHead, defaultType, headLength)
    })
  }
  source.headWritten = true
}

export function writeFailure(res: HttpResponse, source: UwsSource): void {
  if (source.aborted || source.settled) return
  if (source.headWritten) {
    res.close()
    return
  }
  res.cork(() => {
    res.writeStatus("500 Internal Server Error")
    res.writeHeader("content-type", JSON_CONTENT_TYPE)
    res.end(INTERNAL_ERROR_BODY)
  })
  source.headWritten = true
}

/** Write a node-direct outcome. Resolves when the response is complete; sync outcomes return nothing. */
export function writeOutcome(
  res: HttpResponse,
  source: UwsSource,
  outcome: NodeServeOutcome,
  isHead: boolean,
  inHandler: boolean,
): void | Promise<void> {
  if (source.aborted) return
  switch (outcome.kind) {
    case "json":
      writeBuffered(
        res,
        source,
        outcome.status,
        outcome.headers,
        outcome.cookies,
        outcome.body,
        isHead,
        JSON_CONTENT_TYPE,
        inHandler,
      )
      return
    case "body":
      writeBuffered(
        res,
        source,
        outcome.status,
        outcome.headers,
        undefined,
        outcome.body,
        isHead,
        undefined,
        inHandler,
      )
      return
    case "response":
      return writeResponse(res, source, outcome.response, isHead, inHandler)
  }
}

function writeResponse(
  res: HttpResponse,
  source: UwsSource,
  response: Response,
  isHead: boolean,
  inHandler: boolean,
): void | Promise<void> {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") headers[name] = value
  })
  const cookies = response.headers.getSetCookie()
  const status = response.status
  const stream = response.body
  if (stream === null || isBodyless(status)) {
    writeBuffered(res, source, status, headers, cookies, null, isHead, undefined, inHandler)
    return
  }
  if (isHead) {
    void stream.cancel().catch(() => {})
    writeBuffered(
      res,
      source,
      status,
      headers,
      cookies,
      null,
      true,
      undefined,
      inHandler,
      declaredLength(headers) ?? 0,
    )
    return
  }
  return pump(res, source, status, headers, cookies, stream)
}

/**
 * A streamed body. A body that ends within its first two chunks goes out as one buffered write; a
 * longer one is chunked, or - when the response declares its length - sent with `tryEnd` so uWS
 * frames it by `Content-Length`. Both wait on `onWritable` when the socket backs up.
 */
async function pump(
  res: HttpResponse,
  source: UwsSource,
  status: number,
  headers: Record<string, string>,
  cookies: readonly string[],
  stream: ReadableStream<Uint8Array>,
): Promise<void> {
  const reader = stream.getReader()
  let unblock: (() => void) | undefined
  source.onAbort = () => {
    void reader.cancel().catch(() => {})
    unblock?.()
  }
  const declared = declaredLength(headers)
  const pending: Uint8Array[] = []
  let finished = false
  for (let i = 0; i < 2 && !finished; i++) {
    const next = await reader.read()
    if (source.aborted) return
    if (next.done) finished = true
    else if (next.value.byteLength > 0) pending.push(next.value)
  }
  if (finished) {
    const [first] = pending
    const only = first === undefined ? null : pending.length === 1 ? first : Buffer.concat(pending)
    writeBuffered(res, source, status, headers, cookies, only, false, undefined, false)
    return
  }
  validate(status, headers, cookies)
  const waitWritable = (): Promise<void> =>
    new Promise<void>((resolve) => {
      unblock = resolve
    })
  if (declared === undefined) {
    let ok = true
    res.cork(() => {
      res.writeStatus(statusLine(status))
      emitHeaders(res, headers, cookies, undefined)
      for (const chunk of pending) ok = res.write(chunk)
    })
    source.headWritten = true
    for (;;) {
      if (!ok) {
        const writable = waitWritable()
        res.onWritable(() => {
          unblock?.()
          return true
        })
        await writable
      }
      if (source.aborted) return
      const next = await reader.read()
      if (source.aborted) return
      if (next.done) break
      if (next.value.byteLength === 0) continue
      res.cork(() => {
        ok = res.write(next.value)
      })
    }
    res.cork(() => {
      res.end()
    })
    return
  }

  // Known length: tryEnd frames the body by Content-Length and reports back-pressure by offset.
  let sentBefore = 0
  let responded = false
  let headSent = false
  const feed = (chunk: Uint8Array): boolean => {
    let ok = false
    res.cork(() => {
      if (!headSent) {
        res.writeStatus(statusLine(status))
        emitHeaders(res, headers, cookies, undefined)
        headSent = true
        source.headWritten = true
      }
      const result = res.tryEnd(chunk, declared)
      ok = result[0]
      responded = result[1]
    })
    return ok
  }
  const queue = pending.slice()
  for (;;) {
    let chunk = queue.shift()
    if (chunk === undefined) {
      const next = await reader.read()
      if (source.aborted) return
      if (next.done) break
      chunk = next.value
      if (chunk.byteLength === 0) continue
    }
    if (sentBefore + chunk.byteLength > declared) {
      res.close()
      throw new RangeError("response body is longer than its Content-Length")
    }
    const start = sentBefore
    const view = chunk
    sentBefore += view.byteLength
    if (!feed(view) && !responded) {
      const writable = waitWritable()
      res.onWritable((offset) => {
        const rest = view.subarray(offset - start)
        let ok = false
        res.cork(() => {
          const result = res.tryEnd(rest, declared)
          ok = result[0]
          responded = result[1]
        })
        if (ok || responded) unblock?.()
        return ok
      })
      await writable
      if (source.aborted) return
    }
    if (responded) return
  }
  if (!responded) {
    res.close()
    throw new RangeError("response body is shorter than its Content-Length")
  }
}
