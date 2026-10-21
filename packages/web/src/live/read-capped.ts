/**
 * A request body as text, read only up to `max` bytes, or the status to refuse it with: 413 past the
 * cap, declared or delivered; 400 for a malformed length or invalid UTF-8.
 */
export async function readCapped(req: Request, max: number): Promise<string | 400 | 413> {
  const declared = req.headers.get("content-length")
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) return 400
    if (Number(declared) > max) return 413
  }
  if (req.body === null) return ""
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await Promise.allSettled([reader.cancel()])
      return 413
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return 400
  }
}
