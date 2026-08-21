/**
 * Content-addressing helpers shared by the orchestration module: a SHA-256 hex digest over bytes
 * and a canonical JSON encoding with sorted object keys so a digest is stable across key order.
 * Mirrors `@nifrajs/core`'s idempotency fingerprint (the content-free key precedent).
 */

const encoder = new TextEncoder()

/** SHA-256 of `bytes` as lowercase hex. Collision-resistant so a digest cannot be forged from content. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into a fresh ArrayBuffer-backed view so the digest input is a concrete BufferSource
  // regardless of the caller's backing buffer (SharedArrayBuffer-typed views are rejected).
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))
  const view = new Uint8Array(digest)
  let hex = ""
  for (let i = 0; i < view.length; i++) hex += (view[i] as number).toString(16).padStart(2, "0")
  return hex
}

/** SHA-256 hex of a UTF-8 string. */
export function sha256HexOf(text: string): Promise<string> {
  return sha256Hex(encoder.encode(text))
}

/** Deterministic JSON with recursively sorted object keys. Arrays keep order. Rejects non-finite numbers. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value)
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite JSON number")
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`
  }
  throw new TypeError(`cannot canonicalize ${typeof value}`)
}
