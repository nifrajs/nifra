export type MultipartBody =
  | string
  | Uint8Array
  | ArrayBuffer
  | ArrayBufferView
  | Blob
  | ReadableStream<Uint8Array>

export type MultipartHeadersInit =
  | Headers
  | Readonly<Record<string, string>>
  | ReadonlyArray<readonly [string, string]>

export interface MultipartPart {
  readonly headers?: MultipartHeadersInit
  readonly body: MultipartBody
}

export interface MultipartResponseOptions {
  /** Boundary token. If omitted, a cryptographically random boundary is generated. */
  readonly boundary?: string
  /** Multipart subtype. Defaults to `mixed`; use `form-data` when parts carry form names. */
  readonly subtype?: "mixed" | "form-data"
  /** HTTP response status. Defaults to 200. */
  readonly status?: number
}

const TEXT = new TextEncoder()
const BOUNDARY = /^[A-Za-z0-9'()+_,./:=? -]{1,70}$/

interface ActiveReader {
  current: ReadableStreamDefaultReader<Uint8Array> | undefined
}

function validateBoundary(value: string): string {
  if (!BOUNDARY.test(value) || value.endsWith(" ")) {
    throw new TypeError("multipartResponse: boundary must be a valid RFC token")
  }
  return value
}

function headersOf(init: MultipartHeadersInit | undefined): Headers {
  const headers = new Headers()
  if (init instanceof Headers) {
    for (const [name, value] of init) headers.set(name, value)
  } else if (Array.isArray(init)) {
    for (const [name, value] of init) headers.append(name, value)
  } else if (init !== undefined) {
    for (const [name, value] of Object.entries(init)) headers.append(name, value)
  }
  for (const [name, value] of headers) {
    if (hasHeaderControlCharacter(name) || hasHeaderControlCharacter(value)) {
      throw new TypeError("multipartResponse: part headers cannot contain control characters")
    }
  }
  return headers
}

function hasHeaderControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    // HTAB is the only C0 control permitted in an HTTP field value. Reject the rest, including
    // DEL, so a caller cannot smuggle non-printing bytes into a multipart header line.
    if ((code <= 31 && code !== 9) || code === 127) return true
  }
  return false
}

async function* bodyChunks(
  body: MultipartBody,
  activeReader: ActiveReader,
): AsyncGenerator<Uint8Array> {
  if (typeof body === "string") {
    yield TEXT.encode(body)
    return
  }
  if (body instanceof Uint8Array) {
    yield body
    return
  }
  if (body instanceof ArrayBuffer) {
    yield new Uint8Array(body)
    return
  }
  if (ArrayBuffer.isView(body)) {
    yield new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
    return
  }
  const stream = body instanceof Blob ? body.stream() : body
  const reader = stream.getReader() as ReadableStreamDefaultReader<Uint8Array>
  activeReader.current = reader
  let completed = false
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) {
        completed = true
        return
      }
      yield result.value
    }
  } finally {
    if (activeReader.current === reader) activeReader.current = undefined
    if (!completed) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

async function* encodeParts(
  parts: Iterable<MultipartPart> | AsyncIterable<MultipartPart>,
  boundary: string,
  activeReader: ActiveReader,
): AsyncGenerator<Uint8Array> {
  for await (const part of parts) {
    if (part === null || typeof part !== "object") {
      throw new TypeError("multipartResponse: every part must be an object")
    }
    yield TEXT.encode(`--${boundary}\r\n`)
    for (const [name, value] of headersOf(part.headers)) {
      yield TEXT.encode(`${name}: ${value}\r\n`)
    }
    yield TEXT.encode("\r\n")
    yield* bodyChunks(part.body, activeReader)
    yield TEXT.encode("\r\n")
  }
  yield TEXT.encode(`--${boundary}--\r\n`)
}

/**
 * Stream a multipart response without buffering the parts. The part headers and bodies are emitted
 * as supplied; this helper deliberately does not persist, inspect, or serialize payloads.
 */
export function multipartResponse(
  parts: Iterable<MultipartPart> | AsyncIterable<MultipartPart>,
  options: MultipartResponseOptions = {},
): Response {
  const boundary = validateBoundary(
    options.boundary ?? `nifra-${crypto.randomUUID().replaceAll("-", "")}`,
  )
  const subtype = options.subtype ?? "mixed"
  const activeReader: ActiveReader = { current: undefined }
  const iterator = encodeParts(parts, boundary, activeReader)[Symbol.asyncIterator]()
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await iterator.next()
        if (result.done) controller.close()
        else controller.enqueue(result.value)
      } catch (error) {
        const reader = activeReader.current
        if (reader !== undefined) await reader.cancel(error).catch(() => {})
        await iterator.return?.(error)
        controller.error(error)
      }
    },
    async cancel(reason) {
      const reader = activeReader.current
      if (reader !== undefined) await reader.cancel(reason).catch(() => {})
      await iterator.return?.(reason)
    },
  })
  return new Response(stream, {
    status: options.status ?? 200,
    headers: { "content-type": `multipart/${subtype}; boundary=${boundary}` },
  })
}
