/**
 * Share-link codec for the playground. Serializes the two editor strings ({ code, requests }) into a
 * compact, URL-safe payload that lives in the page `#fragment` — so a link reconstructs the exact
 * editor state and runs the real app in the opener's tab. The fragment never reaches the server, so
 * CDN/URL-length server limits don't apply; the only real cap is the browser address bar.
 *
 * Security: a share payload is attacker-controlled. Decoding validates strictly at the trust boundary
 * (version + shape + per-field length) and bounds the decompressed size to defuse a gzip bomb. It never
 * throws — a malformed link returns null and the caller falls back to the default preset. (Running the
 * decoded code is the *existing* playground trust model: it executes in the opener's own tab, same as
 * pasting into the devtools console — surface that in the UI, don't pretend the link is sandboxed.)
 */

const VERSION = 1
const HASH_KEY = "play" // location.hash === `#play=<base64url>`
const MAX_PAYLOAD_CHARS = 64_000 // refuse absurd fragments before doing any work
const MAX_DECOMPRESSED_BYTES = 512 * 1024 // gzip-bomb guard
const MAX_FIELD_CHARS = 200_000 // per-editor sanity cap

export interface ShareState {
  readonly code: string
  readonly requests: string
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ""
  const CHUNK = 0x8000 // chunk so the String.fromCharCode spread stays under the arg-count limit
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function fromBase64Url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/")
  const padded = b64.length % 4 === 0 ? b64 : b64 + "=".repeat(4 - (b64.length % 4))
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Decompress with a hard output cap — a small gzip can expand to gigabytes, so abort past the limit. */
async function gunzipBounded(bytes: Uint8Array, max: number): Promise<Uint8Array> {
  const ds = new DecompressionStream("gzip")
  const writer = ds.writable.getWriter()
  // Bad (non-gzip) input rejects on BOTH ends; the reader-side error below is the one we act on, so
  // swallow the writer-side rejection to avoid an unhandled-rejection log for the same failure.
  writer.write(bytes).catch(() => {})
  writer.close().catch(() => {})
  const reader = ds.readable.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel()
      throw new Error("share payload exceeds the decompressed size limit")
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

export async function encodeState(state: ShareState): Promise<string> {
  const json = JSON.stringify({ v: VERSION, code: state.code, requests: state.requests })
  return toBase64Url(await gzip(new TextEncoder().encode(json)))
}

/** Returns the editor state for a valid payload, or null for anything malformed/oversized/wrong-version. */
export async function decodeState(payload: string): Promise<ShareState | null> {
  try {
    if (!payload || payload.length > MAX_PAYLOAD_CHARS) return null
    const decompressed = await gunzipBounded(fromBase64Url(payload), MAX_DECOMPRESSED_BYTES)
    const parsed: unknown = JSON.parse(new TextDecoder().decode(decompressed))
    if (typeof parsed !== "object" || parsed === null) return null
    const { v, code, requests } = parsed as Record<string, unknown>
    if (v !== VERSION || typeof code !== "string" || typeof requests !== "string") return null
    if (code.length > MAX_FIELD_CHARS || requests.length > MAX_FIELD_CHARS) return null
    return { code, requests }
  } catch {
    return null // never throw at the trust boundary — caller falls back to the default preset
  }
}

export function shareHash(payload: string): string {
  return `#${HASH_KEY}=${payload}`
}

/** Extract the share payload from a `#play=<…>` fragment, or null. The base64url alphabet is URL-safe. */
export function readShareHash(hash: string): string | null {
  const match = hash.match(new RegExp(`[#&]${HASH_KEY}=([^&]+)`))
  return match ? (match[1] ?? null) : null
}
