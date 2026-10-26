/** Lowercase hex, two digits a byte. */
export function bytesToHex(bytes: Uint8Array): string {
  let hex = ""
  for (let i = 0; i < bytes.length; i++) hex += (bytes[i] ?? 0).toString(16).padStart(2, "0")
  return hex
}

/** SHA-256 of `bytes`, as lowercase hex. A collision-resistant content digest for a strong validator. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy so a backend-owned mutable buffer cannot change while Web Crypto is reading it.
  const stable = new Uint8Array(bytes.byteLength)
  stable.set(bytes)
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", stable)))
}
