import { ServerComponentError } from "./error.ts"
import { COMPONENT_LIMITS } from "./protocol.ts"

export function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

/** The bounded snapshot is shared by SSR and hydration; it never tees into an unread branch. */
export async function readComponentBytes(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  limit: number = COMPONENT_LIMITS.outputBytes,
): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  const cancel = () => {
    void reader.cancel().catch(() => {
      /* Keep the primary read failure. */
    })
  }
  signal.addEventListener("abort", cancel, { once: true })
  try {
    while (true) {
      if (signal.aborted) throw new ServerComponentError("component_cancelled", 499)
      const result = await reader.read()
      if (result.done) break
      if (result.value.length === 0) throw new ServerComponentError("component_protocol", 400)
      size += result.value.length
      if (size > limit) throw new ServerComponentError("component_limit", 413)
      chunks.push(result.value)
    }
    if (signal.aborted) throw new ServerComponentError("component_cancelled", 499)
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    return bytes
  } catch (error) {
    await reader.cancel().catch(() => {
      /* Keep the primary read failure. */
    })
    throw error
  } finally {
    signal.removeEventListener("abort", cancel)
    reader.releaseLock()
  }
}

export function encodeComponentBytes(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function decodeComponentBytes(value: unknown): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length > Math.ceil(COMPONENT_LIMITS.outputBytes / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    throw new ServerComponentError("component_protocol", 400)
  return Uint8Array.from(atob(value), (item) => item.charCodeAt(0))
}
