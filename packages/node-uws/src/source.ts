import { BodyChannel } from "./body.ts"
import type { HttpRequest, HttpResponse } from "./uws.ts"

const decoder = new TextDecoder()

/** What a nifra app reads of the connection: the socket peer, resolved only when something asks. */
export class UwsPlatform {
  private res: HttpResponse | null
  private ip: string | undefined

  constructor(res: HttpResponse) {
    this.res = res
  }

  get clientIp(): string | undefined {
    if (this.ip === undefined && this.res !== null) {
      try {
        this.ip = decoder.decode(this.res.getRemoteAddressAsText())
      } catch {
        // Read after the response ended (an after-response hook): the peer is no longer available.
        this.res = null
      }
    }
    return this.ip
  }

  /** The uWS response is gone once the handler returns and the answer is async: keep the peer. */
  detach(): void {
    if (this.res === null) return
    void this.clientIp
    this.res = null
  }
}

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

const parseJson = (bytes: Uint8Array): unknown => JSON.parse(decoder.decode(bytes))

/**
 * One request as `app.resolveNodeSource` reads it. The uWS request object is valid only until the
 * handler returns, so headers are read live while the app answers synchronously and copied out the
 * moment it goes asynchronous ({@link detach}).
 */
export class UwsSource {
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
  private snapshot: Record<string, string> | undefined
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
    return this.snapshot?.[lower] ?? null
  }

  detach(): void {
    if (this.req === null) return
    this.snapshot = this.collect()
    this.req = null
  }

  private collect(): Record<string, string> {
    if (this.snapshot !== undefined) return this.snapshot
    const record: Record<string, string> = Object.create(null)
    this.req?.forEach((key, value) => {
      const seen = record[key]
      record[key] = seen === undefined ? value : `${seen}, ${value}`
    })
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
