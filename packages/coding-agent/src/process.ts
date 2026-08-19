export interface BoundedText {
  readonly text: string
  readonly truncated: boolean
}

export async function readBoundedText(
  stream: ReadableStream<Uint8Array> | null | undefined | number,
  maxBytes: number,
): Promise<BoundedText> {
  if (stream === null || stream === undefined || typeof stream === "number")
    return { text: "", truncated: false }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new RangeError("bounded process output: maxBytes must be positive")
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let total = 0
  let truncated = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        chunks.push(decoder.decode())
        break
      }
      if (value === undefined) continue
      const remaining = maxBytes - total
      if (remaining <= 0) {
        truncated = true
        await reader.cancel()
        break
      }
      if (value.byteLength > remaining) {
        chunks.push(decoder.decode(value.subarray(0, remaining), { stream: true }))
        chunks.push(decoder.decode())
        truncated = true
        await reader.cancel()
        break
      }
      total += value.byteLength
      chunks.push(decoder.decode(value, { stream: true }))
    }
  } finally {
    reader.releaseLock()
  }
  return { text: chunks.join(""), truncated }
}
