const encoder = new TextEncoder()

/** Lowercase hex, two digits per byte. */
export function bytesToHex(bytes: Uint8Array): string {
  let hex = ""
  for (let i = 0; i < bytes.length; i++) hex += (bytes[i] ?? 0).toString(16).padStart(2, "0")
  return hex
}

/** SHA-256 of UTF-8 text or a stable copy of bytes, as lowercase hex. */
export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string" ? encoder.encode(input) : new Uint8Array(input)
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
}
