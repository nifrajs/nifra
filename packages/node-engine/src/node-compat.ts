import diagnosticsChannel from "node:diagnostics_channel"
import { IncomingMessage, type OutgoingHttpHeaders, ServerResponse } from "node:http"
import type { Socket } from "node:net"
import { Duplex } from "node:stream"
import type { FetchHandler, PeerCertificateInfo } from "./options.ts"

const chResponseCreated = diagnosticsChannel.channel("http.server.response.created")
const chRequestStart = diagnosticsChannel.channel("http.server.request.start")
const chResponseFinish = diagnosticsChannel.channel("http.server.response.finish")

export interface HttpDiagnosticsHandle {
  finish(status: number, headers?: Readonly<Record<string, string>>): void
}

export function hasHttpDiagnosticsSubscribers(): boolean {
  return (
    chResponseCreated.hasSubscribers ||
    chRequestStart.hasSubscribers ||
    chResponseFinish.hasSubscribers
  )
}

/**
 * Publish Node's `http.server.response.created`, `http.server.request.start`, and
 * `http.server.response.finish` diagnostics channels for auto-instrumentation agents when subscribed.
 */
export function beginHttpDiagnostics(
  request: Request,
  control: EngineRequestControl | undefined,
  server: object,
): HttpDiagnosticsHandle {
  const parsedUrl = new URL(request.url)
  const socket = new CompatSocket(
    control?.clientIp ?? "127.0.0.1",
    parsedUrl.protocol === "https:",
    control,
    () => {},
    () => {},
  )
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: CompatSocket satisfies the net.Socket shape expected by IncomingMessage
  const req = new IncomingMessage(socket as unknown as Socket)
  req.method = request.method
  req.url = `${parsedUrl.pathname}${parsedUrl.search}`
  req.httpVersion = control?.isH2 ? "2.0" : "1.1"
  req.httpVersionMajor = control?.isH2 ? 2 : 1
  req.httpVersionMinor = control?.isH2 ? 0 : 1
  const rawHeaders: string[] = []
  request.headers.forEach((value, name) => {
    rawHeaders.push(name, value)
    req.headers[name] = value
  })
  req.rawHeaders = rawHeaders
  const res = new ServerResponse(req)
  if (chResponseCreated.hasSubscribers) {
    chResponseCreated.publish({ request: req, response: res })
  }
  if (chRequestStart.hasSubscribers) {
    chRequestStart.publish({ request: req, response: res, socket, server })
  }
  let finished = false
  return {
    finish(status, headers) {
      if (finished) return
      finished = true
      res.statusCode = status
      if (headers !== undefined) {
        for (const [k, v] of Object.entries(headers)) {
          if (v !== undefined) res.setHeader(k, v)
        }
      }
      Object.defineProperty(res, "writableEnded", { value: true, configurable: true })
      Object.defineProperty(res, "writableFinished", { value: true, configurable: true })
      if (chResponseFinish.hasSubscribers) {
        chResponseFinish.publish({ request: req, response: res, socket, server })
      }
    },
  }
}

export const SOURCE = Symbol.for("nifra.engine.source")

export interface EngineRequestControl {
  readonly clientIp?: string | undefined
  readonly isH2?: boolean
  readonly trailers?: Readonly<Record<string, string>>
  writeInformational?(
    status: number,
    headers: Readonly<Record<string, string | readonly string[]>>,
  ): boolean
  setTrailers?(trailers: Readonly<Record<string, string>>): boolean
  getPeerCertificate?(detailed?: boolean): PeerCertificateInfo | null
}

type SourcedWebRequest = Request & { readonly [SOURCE]?: EngineRequestControl }

export type NodeRequestListener = (req: IncomingMessage, res: ServerResponse) => void

export type NodeMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (error?: unknown) => void,
) => void

export interface NodeMiddlewareContextLike {
  readonly req: Request
  readonly set?: {
    status?: number
    readonly headers: Record<string, string>
  }
}

const HEAD_END = Buffer.from("\r\n\r\n")
const BODYLESS_STATUSES = new Set([204, 205, 304])

/**
 * Minimal `net.Socket` / `tls.TLSSocket`-compatible Duplex stream used to back Node's
 * `IncomingMessage` and `ServerResponse` inside `@nifrajs/node-engine`.
 */
export class CompatSocket extends Duplex {
  readonly remoteAddress: string
  readonly remoteFamily: string
  readonly remotePort = 0
  readonly encrypted: boolean
  readonly authorized: boolean
  private readonly control: EngineRequestControl | undefined
  private readonly onBodyBytes: (chunk: Buffer) => void
  private readonly onStreamEnd: () => void
  private headStripped = false
  private headBuffer: Buffer = Buffer.alloc(0)

  constructor(
    remoteAddress: string,
    encrypted: boolean,
    control: EngineRequestControl | undefined,
    onBodyBytes: (chunk: Buffer) => void,
    onStreamEnd: () => void,
  ) {
    super()
    this.remoteAddress = remoteAddress
    this.remoteFamily = remoteAddress.includes(":") ? "IPv6" : "IPv4"
    this.encrypted = encrypted
    this.control = control
    this.authorized =
      control?.getPeerCertificate?.() !== null && control?.getPeerCertificate?.() !== undefined
    this.onBodyBytes = onBodyBytes
    this.onStreamEnd = onStreamEnd
  }

  getPeerCertificate(detailed = false): PeerCertificateInfo | NonNullable<unknown> {
    return this.control?.getPeerCertificate?.(detailed) ?? {}
  }

  override _read(): void {}

  override _write(
    chunk: Buffer | Uint8Array | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === "string"
        ? Buffer.from(chunk, encoding)
        : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    if (!this.headStripped) {
      this.headBuffer =
        this.headBuffer.byteLength === 0 ? buf : Buffer.concat([this.headBuffer, buf])
      const endIdx = this.headBuffer.indexOf(HEAD_END)
      if (endIdx === -1) {
        callback()
        return
      }
      this.headStripped = true
      const remainder = this.headBuffer.subarray(endIdx + 4)
      this.headBuffer = Buffer.alloc(0)
      if (remainder.byteLength > 0) this.onBodyBytes(remainder)
      callback()
      return
    }
    if (buf.byteLength > 0) this.onBodyBytes(buf)
    callback()
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.onStreamEnd()
    callback()
  }

  setTimeout(): this {
    return this
  }

  setNoDelay(): this {
    return this
  }

  setKeepAlive(): this {
    return this
  }

  address(): { readonly address: string; readonly family: string; readonly port: number } {
    return {
      address: this.remoteAddress,
      family: this.remoteFamily,
      port: this.remotePort,
    }
  }
}

export interface NodeCompatPair {
  readonly req: IncomingMessage
  readonly res: ServerResponse
  readonly socket: CompatSocket
  readonly response: Promise<Response>
  headersForResponse(): Headers
}

function buildHeadersFromOutgoing(outgoing: OutgoingHttpHeaders): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(outgoing)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, String(item))
    } else {
      headers.set(name, String(value))
    }
  }
  return headers
}

function normalizeHintsRecord(
  hints: Readonly<Record<string, string | readonly string[]>>,
): Record<string, string | readonly string[]> {
  const out: Record<string, string | readonly string[]> = {}
  for (const [key, val] of Object.entries(hints)) {
    out[key] = val
  }
  return out
}

function normalizeTrailers(
  headers: OutgoingHttpHeaders | readonly [string, string][],
): Record<string, string> {
  const out: Record<string, string> = {}
  if (Array.isArray(headers)) {
    for (const entry of headers) {
      const k = entry[0]
      const v = entry[1]
      if (typeof k === "string" && v !== undefined) out[k] = String(v)
    }
    return out
  }
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined) out[k] = Array.isArray(v) ? v.join(", ") : String(v)
  }
  return out
}

/**
 * Create a genuine Node `IncomingMessage` and `ServerResponse` pair wired to a Web `Request` (and
 * underlying `@nifrajs/node-engine` request metadata when served by `serve()`).
 */
export function createNodeCompat(request: Request): NodeCompatPair {
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the tag is optional, so an untagged Request yields undefined
  const control = (request as SourcedWebRequest)[SOURCE]
  const parsedUrl = new URL(request.url)
  const bufferedChunks: Buffer[] = []
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
  let responseResolved = false
  let streamEnded = false
  let resolveResponse!: (res: Response) => void
  const responsePromise = new Promise<Response>((resolve) => {
    resolveResponse = resolve
  })

  const buildResponse = (
    body: string | Uint8Array | ReadableStream<Uint8Array> | null,
  ): Response => {
    const status = res.statusCode || 200
    const headers = buildHeadersFromOutgoing(res.getHeaders())
    if (request.method === "HEAD" || BODYLESS_STATUSES.has(status)) {
      return new Response(null, { status, statusText: res.statusMessage, headers })
    }
    return new Response(body, { status, statusText: res.statusMessage, headers })
  }

  const startStreamingIfNeeded = (): void => {
    if (responseResolved) return
    responseResolved = true
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller
        for (const chunk of bufferedChunks) {
          if (chunk.byteLength > 0) controller.enqueue(Uint8Array.from(chunk))
        }
        bufferedChunks.length = 0
        if (streamEnded) controller.close()
      },
    })
    resolveResponse(buildResponse(stream))
  }

  const socket = new CompatSocket(
    control?.clientIp ?? "127.0.0.1",
    parsedUrl.protocol === "https:",
    control,
    (chunk) => {
      if (streamController !== undefined) {
        streamController.enqueue(Uint8Array.from(chunk))
      } else {
        bufferedChunks.push(Buffer.from(chunk))
      }
      if (!responseResolved && res.headersSent && !res.writableEnded) {
        startStreamingIfNeeded()
      }
    },
    () => {
      streamEnded = true
      if (streamController !== undefined) {
        streamController.close()
        return
      }
      if (!responseResolved) {
        responseResolved = true
        const body =
          bufferedChunks.length === 0
            ? null
            : bufferedChunks.length === 1
              ? Uint8Array.from(bufferedChunks[0] ?? [])
              : Uint8Array.from(Buffer.concat(bufferedChunks))
        bufferedChunks.length = 0
        resolveResponse(buildResponse(body))
      }
    },
  )

  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: CompatSocket implements the net.Socket interface methods required by IncomingMessage
  const netSocket = socket as unknown as Socket
  const req = new IncomingMessage(netSocket)
  req.method = request.method
  req.url = `${parsedUrl.pathname}${parsedUrl.search}`
  req.httpVersion = control?.isH2 ? "2.0" : "1.1"
  req.httpVersionMajor = control?.isH2 ? 2 : 1
  req.httpVersionMinor = control?.isH2 ? 0 : 1
  const rawHeaders: string[] = []
  request.headers.forEach((value, name) => {
    rawHeaders.push(name, value)
    const prev = req.headers[name]
    if (prev === undefined) {
      req.headers[name] = value
    } else if (Array.isArray(prev)) {
      prev.push(value)
    } else if (name === "set-cookie") {
      req.headers[name] = [prev, value]
    } else {
      req.headers[name] = `${prev}, ${value}`
    }
  })
  req.rawHeaders = rawHeaders
  if (control?.trailers !== undefined) {
    const preTrailers: Record<string, string | undefined> = Object.create(null)
    for (const [k, v] of Object.entries(control.trailers)) preTrailers[k] = v
    Object.defineProperty(req, "trailers", {
      configurable: true,
      enumerable: true,
      get() {
        const current = control.trailers
        if (current === undefined) return preTrailers
        const copy: Record<string, string> = Object.create(null)
        for (const [k, v] of Object.entries(current)) copy[k] = v
        return copy
      },
    })
  }

  let pumpStarted = false
  const startPump = (): void => {
    if (pumpStarted) return
    pumpStarted = true
    const webBody = request.body
    if (webBody === null) {
      req.complete = true
      req.push(null)
      return
    }
    const reader = webBody.getReader()
    const pump = async (): Promise<void> => {
      try {
        for (;;) {
          const next = await reader.read()
          if (next.done) break
          if (next.value.byteLength > 0) {
            req.push(Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength))
          }
        }
        req.complete = true
        req.push(null)
      } catch (err) {
        req.destroy(err instanceof Error ? err : new Error("Request body error"))
      }
    }
    void pump()
  }

  req._read = () => {
    startPump()
  }
  if (request.body === null) {
    req.complete = true
    req.push(null)
  }

  request.signal.addEventListener(
    "abort",
    () => {
      req.destroyed = true
      req.emit("aborted")
      req.emit("close")
    },
    { once: true },
  )

  const res = new ServerResponse(req)
  res.useChunkedEncodingByDefault = false
  res.assignSocket(netSocket)
  res.on("finish", () => {
    if (!socket.writableEnded) socket.end()
  })

  if (control?.writeInformational !== undefined) {
    const writeInfo = control.writeInformational.bind(control)
    res.writeEarlyHints = (hints, callback) => {
      writeInfo(103, normalizeHintsRecord(hints))
      callback?.()
    }
  }
  if (control?.setTrailers !== undefined) {
    const setTrailers = control.setTrailers.bind(control)
    const origAddTrailers = ServerResponse.prototype.addTrailers
    res.addTrailers = function addCompatTrailers(
      this: ServerResponse,
      headers: OutgoingHttpHeaders | readonly [string, string][],
    ): void {
      setTrailers(normalizeTrailers(headers))
      origAddTrailers.call(this, headers)
    }
  }

  return {
    req,
    res,
    socket,
    response: responsePromise,
    headersForResponse: () => buildHeadersFromOutgoing(res.getHeaders()),
  }
}

/**
 * Wrap a Node `http.RequestListener` — including an entire Express application (`express()`) —
 * into a Web `FetchHandler` + fetch function that runs directly inside `@nifrajs/node-engine` `serve()`.
 */
export function fromNodeHandler(
  handler: NodeRequestListener,
): FetchHandler & ((request: Request) => Promise<Response>) {
  const fetchFn = (request: Request): Promise<Response> => {
    const pair = createNodeCompat(request)
    try {
      handler(pair.req, pair.res)
    } catch (err) {
      if (!pair.res.writableEnded) {
        pair.res.destroy(err instanceof Error ? err : new Error(String(err)))
      }
      return Promise.reject(err)
    }
    return pair.response
  }
  return Object.assign(fetchFn, { fetch: fetchFn })
}

/**
 * Run one or more Node/Express-style `(req, res, next)` middlewares inside either a Nifra hook
 * (`app.onRequest(...)` / route handler) or a plain Fetch pipeline. Short-circuits with a `Response`
 * when middleware ends `res`, propagates headers/status to `c.set` when calling `next()`, and rejects
 * when `next(err)` is invoked.
 */
export function fromNodeMiddleware(
  ...middlewares: readonly NodeMiddleware[]
): (target: Request | NodeMiddlewareContextLike) => Promise<Response | undefined> {
  return async (target: Request | NodeMiddlewareContextLike): Promise<Response | undefined> => {
    const context = "req" in target ? target : undefined
    const request = "req" in target ? target.req : target
    const pair = createNodeCompat(request)

    let settled = false
    return new Promise<Response | undefined>((resolve, reject) => {
      const cleanup = (outcome?: Response): void => {
        if (settled) return
        settled = true
        if (outcome !== undefined) {
          resolve(outcome)
          return
        }
        if (context?.set !== undefined) {
          if (pair.res.statusCode !== 200) context.set.status = pair.res.statusCode
          const outHeaders = pair.res.getHeaders()
          for (const [k, v] of Object.entries(outHeaders)) {
            if (v !== undefined) {
              context.set.headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v)
            }
          }
        }
        resolve(undefined)
      }

      void pair.response.then((resp) => {
        if (!settled) cleanup(resp)
      })

      let idx = 0
      const step = (err?: unknown): void => {
        if (settled || pair.res.writableEnded) return
        if (err !== undefined) {
          settled = true
          reject(err instanceof Error ? err : new Error(String(err)))
          return
        }
        const mw = middlewares[idx++]
        if (mw === undefined) {
          cleanup(undefined)
          return
        }
        try {
          mw(pair.req, pair.res, step)
        } catch (caught) {
          settled = true
          reject(caught instanceof Error ? caught : new Error(String(caught)))
        }
      }

      step()
    })
  }
}
