import { BodyChannel } from "./body.ts"
import type { HttpRequest, HttpResponse } from "./uws.ts"

const decoder = new TextDecoder()

interface RawBodyReaders {
  readonly headers: Pick<Headers, "get">
  readonly body: ReadableStream<Uint8Array> | null
  arrayBuffer(): Promise<ArrayBuffer>
  bytes(): Promise<Uint8Array>
  json(): Promise<unknown>
}

function detached(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer
}

// Fetch's `json()` decodes UTF-8 without a leading byte order mark; `Buffer#toString` keeps one, and
// `JSON.parse` then refuses a body every other runtime parses.
const utf8Text = (body: Buffer): string =>
  body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf
    ? body.toString("utf8", 3)
    : body.toString("utf8")

const parseJson = (body: Buffer): unknown => JSON.parse(utf8Text(body))

/**
 * One request as `app.resolveNodeSource` reads it. The uWS request object is valid only until the
 * handler returns, so headers are read live while the app answers synchronously and copied out the
 * moment it goes asynchronous ({@link detach}).
 */
export class UwsSource {
  /** Also the `platform` handed to the app: the socket peer, resolved only when something asks. */
  get clientIp(): string | undefined {
    if (this.peer === undefined && this.res !== null) {
      try {
        this.peer = decoder.decode(this.res.getRemoteAddressAsText())
      } catch {
        // Read after the response ended (an after-response hook): the peer is no longer available.
        this.res = null
      }
    }
    return this.peer
  }

  readonly method: string
  readonly channel: BodyChannel | null
  /** The client disconnected before the answer was written. */
  aborted = false
  /** The response was ended or the connection closed; nothing may be written after this. */
  settled = false
  /** Status and headers are on the wire, so a failure can only cut the connection. */
  headWritten = false
  /** Cancels a body being streamed out when the client goes away. */
  onAbort: (() => void) | undefined

  private readonly target: string
  private readonly authority: string
  private readonly protocol: string
  private req: HttpRequest | null
  private res: HttpResponse | null
  private peer: string | undefined
  /** `[name, value, ...]`, copied out when the app goes asynchronous. */
  private captured: string[] | undefined
  private urlValue: string | undefined
  private headersValue: Headers | undefined
  private requestValue: Request | undefined
  private controller: AbortController | undefined
  private readers: RawBodyReaders | undefined

  constructor(
    method: string,
    target: string,
    authority: string,
    protocol: string,
    req: HttpRequest,
    res: HttpResponse,
  ) {
    this.method = method
    this.target = target
    this.authority = authority
    this.protocol = protocol
    this.req = req
    this.res = res
    this.channel = method === "GET" || method === "HEAD" ? null : new BodyChannel(res)
  }

  /** The connection closed: reject a body still being read, stop an answer still being produced. */
  abort(): void {
    if (this.aborted) return
    this.aborted = true
    this.channel?.abort(new Error("request closed before body completed"))
    this.channel?.close()
    this.controller?.abort()
    this.onAbort?.()
  }

  get url(): string {
    this.urlValue ??= `${this.protocol}://${this.authority}${this.target}`
    return this.urlValue
  }

  get urlParts(): { pathname: string; search: string } {
    const mark = this.target.indexOf("?")
    return mark === -1
      ? { pathname: this.target, search: "" }
      : { pathname: this.target.slice(0, mark), search: this.target.slice(mark) }
  }

  header(name: string): string | null {
    const lower = name.toLowerCase()
    if (this.req !== null) return this.req.getHeader(lower) || null
    const pairs = this.captured
    if (pairs === undefined) return null
    let found: string | undefined
    for (let i = 0; i < pairs.length; i += 2) {
      if (pairs[i] === lower) {
        const value = pairs[i + 1] ?? ""
        found = found === undefined ? value : `${found}, ${value}`
      }
    }
    return found || null
  }

  detach(): void {
    if (this.req === null) return
    const pairs: string[] = []
    this.req.forEach((key, value) => {
      pairs.push(key, value)
    })
    this.captured = pairs
    this.req = null
  }

  /** The uWS objects are gone once the response ended, so nothing may reach for them again. */
  release(): void {
    this.req = null
    this.res = null
  }

  private collect(): Record<string, string> {
    const record: Record<string, string> = Object.create(null)
    const add = (key: string, value: string): void => {
      const seen = record[key]
      record[key] = seen === undefined ? value : `${seen}, ${value}`
    }
    const pairs = this.captured
    if (pairs !== undefined)
      for (let i = 0; i < pairs.length; i += 2) add(pairs[i] ?? "", pairs[i + 1] ?? "")
    else this.req?.forEach(add)
    return record
  }

  get headers(): Headers {
    this.headersValue ??= new Headers(this.collect())
    return this.headersValue
  }

  get body(): ReadableStream<Uint8Array> | null {
    return this.channel === null ? null : this.channel.stream()
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    if (this.channel === null) return Promise.resolve(new ArrayBuffer(0))
    return this.channel.bytes().then(detached)
  }

  json(): Promise<unknown> {
    if (this.channel === null)
      return Promise.reject(new SyntaxError("Unexpected end of JSON input"))
    return this.channel.bytes().then(parseJson)
  }

  jsonWithByteLength(): Promise<{ readonly value: unknown; readonly byteLength: number }> {
    if (this.channel === null)
      return Promise.reject(new SyntaxError("Unexpected end of JSON input"))
    return this.channel.bytes().then((bytes) => ({
      value: parseJson(bytes),
      byteLength: bytes.byteLength,
    }))
  }

  /**
   * The cap's pre-shadow readers: header probes hit the live request and the byte readers drain the
   * channel, so a capped `c.req.json()` never builds the `Request` this source defers.
   */
  rawBodyReaders(): RawBodyReaders {
    const source = this
    this.readers ??= {
      headers: { get: (name: string) => source.header(name) },
      get body(): ReadableStream<Uint8Array> | null {
        return source.body
      },
      arrayBuffer: () => source.arrayBuffer(),
      bytes: () =>
        source.channel === null ? Promise.resolve(new Uint8Array(0)) : source.channel.bytes(),
      json: () => source.json(),
    }
    return this.readers
  }

  get request(): Request {
    if (this.requestValue === undefined) {
      const controller = new AbortController()
      if (this.aborted) controller.abort()
      this.controller = controller
      const init: RequestInit & { duplex?: "half" } = {
        method: this.method,
        headers: this.collect(),
        signal: controller.signal,
      }
      if (this.channel !== null) {
        init.body = this.channel.stream()
        init.duplex = "half"
      }
      this.requestValue = new Request(this.url, init)
    }
    return this.requestValue
  }
}
