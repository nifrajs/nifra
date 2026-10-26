const encoder = new TextEncoder()

/** SHA-256 of `text`'s UTF-8 bytes, as lowercase hex. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)))
  let hex = ""
  for (let i = 0; i < digest.length; i++) hex += (digest[i] ?? 0).toString(16).padStart(2, "0")
  return hex
}
