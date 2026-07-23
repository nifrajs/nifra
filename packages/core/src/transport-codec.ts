/**
 * Versioned, bounded codecs shared by HTTP bodies, loader streams, and WebSocket frames. Plain JSON
 * remains the zero-configuration fast path; rich wire is explicit and preserves non-JSON values.
 */

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024
const TOKEN = /^[a-z][a-z0-9_.-]{0,63}$/

export interface TransportDecodeOptions {
  readonly maxBytes?: number
}

export interface TransportCodec {
  readonly id: string
  readonly version: number
  readonly mediaType: string
  encode(value: unknown): string
  decode(text: string): unknown
}

export class TransportCodecError extends TypeError {
  constructor(message: string) {
    super(message)
    this.name = "TransportCodecError"
  }
}

function maxBytesOf(options: TransportDecodeOptions): number {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new RangeError("transport maxBytes must be a non-negative safe integer")
  return maxBytes
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

function assertBounded(text: string, options: TransportDecodeOptions): void {
  if (byteLength(text) > maxBytesOf(options)) {
    throw new TransportCodecError("transport payload exceeds maxBytes")
  }
}

export const plainJsonCodec: TransportCodec = Object.freeze({
  id: "json",
  version: 1,
  mediaType: "application/json",
  encode(value: unknown): string {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new TransportCodecError("value is not JSON serializable")
    return encoded
  },
  decode(text: string): unknown {
    return JSON.parse(text)
  },
})

export interface TransportCodecRegistry {
  readonly fallback: TransportCodec
  forContentType(contentType: string | null): TransportCodec
  negotiate(accept: string | null): TransportCodec
  byIdentity(id: string, version: number): TransportCodec
}

function canonicalMediaType(value: string): string {
  return value
    .split(";")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .join(";")
}

export function createTransportCodecRegistry(
  codecs: readonly TransportCodec[],
  fallback: TransportCodec = plainJsonCodec,
): TransportCodecRegistry {
  if (codecs.length === 0) throw new TypeError("transport codec registry cannot be empty")
  const byMedia = new Map<string, TransportCodec>()
  const byId = new Map<string, TransportCodec>()
  for (const codec of codecs) {
    if (!TOKEN.test(codec.id)) throw new TypeError("transport codec id is invalid")
    if (!Number.isSafeInteger(codec.version) || codec.version < 1)
      throw new TypeError("transport codec version must be a positive safe integer")
    if (typeof codec.encode !== "function" || typeof codec.decode !== "function")
      throw new TypeError("transport codec must provide encode and decode")
    const media = canonicalMediaType(codec.mediaType)
    const identity = `${codec.id}@${codec.version}`
    if (byMedia.has(media) || byId.has(identity))
      throw new TypeError("duplicate transport codec registration")
    byMedia.set(media, codec)
    byId.set(identity, codec)
  }
  if (!byId.has(`${fallback.id}@${fallback.version}`))
    throw new TypeError("transport fallback must be registered")

  const forContentType = (contentType: string | null): TransportCodec => {
    if (contentType === null || contentType.trim() === "") return fallback
    const canonical = canonicalMediaType(contentType)
    const direct = byMedia.get(canonical)
    if (direct !== undefined) return direct
    const base = canonical.split(";")[0]
    if (base === "application/json") {
      const json = byId.get("json@1")
      if (json !== undefined) return json
    }
    throw new TransportCodecError(`unsupported transport content type: ${contentType}`)
  }

  return Object.freeze({
    fallback,
    forContentType,
    negotiate(accept: string | null) {
      if (accept === null || accept.trim() === "" || accept.trim() === "*/*") return fallback
      const candidates = accept
        .split(",")
        .map((candidate: string) => {
          const quality = /;\s*q=([01](?:\.\d+)?)\s*$/iu.exec(candidate)
          const q = quality === null ? 1 : Number(quality[1])
          return {
            media: quality === null ? candidate.trim() : candidate.slice(0, quality.index).trim(),
            q,
          }
        })
        .filter(
          (candidate: { readonly media: string; readonly q: number }) =>
            Number.isFinite(candidate.q) && candidate.q > 0 && candidate.q <= 1,
        )
        .sort(
          (
            a: { readonly media: string; readonly q: number },
            b: { readonly media: string; readonly q: number },
          ) => b.q - a.q,
        )
      for (const candidate of candidates) {
        try {
          return forContentType(candidate.media)
        } catch {
          // Try the next advertised representation.
        }
      }
      throw new TransportCodecError("no acceptable transport codec")
    },
    byIdentity(id: string, version: number) {
      const codec = byId.get(`${id}@${version}`)
      if (codec === undefined)
        throw new TransportCodecError(`unsupported transport codec: ${id}@${version}`)
      return codec
    },
  })
}

export const defaultTransportCodecs: TransportCodecRegistry = createTransportCodecRegistry([
  plainJsonCodec,
])

export function encodeTransportResponse(
  value: unknown,
  codec: TransportCodec = plainJsonCodec,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers as ConstructorParameters<typeof Headers>[0])
  headers.set("content-type", codec.mediaType)
  headers.set("vary", appendVary(headers.get("vary"), "accept"))
  return new Response(codec.encode(value), { ...init, headers })
}

function appendVary(current: string | null, name: string): string {
  if (current === null || current.trim() === "") return name
  const values = current.split(",").map((value) => value.trim().toLowerCase())
  return values.includes(name.toLowerCase()) ? current : `${current}, ${name}`
}

async function readBoundedText(
  response: Response,
  options: TransportDecodeOptions,
): Promise<string> {
  const maxBytes = maxBytesOf(options)
  const declared = response.headers.get("content-length")
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > maxBytes)
    throw new TransportCodecError("transport payload exceeds maxBytes")
  if (response.body === null) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (!Number.isSafeInteger(total) || total > maxBytes) {
        await reader.cancel()
        throw new TransportCodecError("transport payload exceeds maxBytes")
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
}

export async function decodeTransportResponse(
  response: Response,
  registry: TransportCodecRegistry = defaultTransportCodecs,
  options: TransportDecodeOptions = {},
): Promise<unknown> {
  const codec = registry.forContentType(response.headers.get("content-type"))
  const text = await readBoundedText(response, options)
  return text === "" ? undefined : codec.decode(text)
}

interface TransportFrame {
  readonly codec: string
  readonly version: number
  readonly payload: string
}

export function encodeTransportFrame(
  value: unknown,
  codec: TransportCodec = plainJsonCodec,
): string {
  return JSON.stringify({ codec: codec.id, version: codec.version, payload: codec.encode(value) })
}

export function decodeTransportFrame(
  frame: string,
  registry: TransportCodecRegistry = defaultTransportCodecs,
  options: TransportDecodeOptions = {},
): unknown {
  assertBounded(frame, options)
  const envelope = JSON.parse(frame) as Partial<TransportFrame>
  if (
    envelope === null ||
    typeof envelope !== "object" ||
    typeof envelope.codec !== "string" ||
    !Number.isSafeInteger(envelope.version) ||
    typeof envelope.payload !== "string"
  ) {
    throw new TransportCodecError("malformed transport frame")
  }
  assertBounded(envelope.payload, options)
  return registry.byIdentity(envelope.codec, envelope.version as number).decode(envelope.payload)
}
