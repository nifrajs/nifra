const encoder = new TextEncoder()

/** Lowercase hex, two digits a byte. */
export function bytesToHex(bytes: Uint8Array): string {
  let hex = ""
  // Indexed: a for-of over the bytes runs 1.4x slower on Bun.
  for (let i = 0; i < bytes.length; i++) hex += (bytes[i] ?? 0).toString(16).padStart(2, "0")
  return hex
}

/** SHA-256 of `text`'s UTF-8 bytes, as lowercase hex. */
export async function sha256Hex(text: string): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))))
}
