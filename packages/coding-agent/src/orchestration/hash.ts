/**
 * Content-addressing helpers shared by the orchestration module: a SHA-256 hex digest over bytes,
 * and core's canonical JSON so a digest is stable across key order.
 */

export { canonicalJson } from "@nifrajs/core/canonical-json"

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
