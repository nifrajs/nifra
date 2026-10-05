import { ServerComponentError } from "./error.ts"
import { COMPONENT_LIMITS } from "./protocol.ts"

const magic = new Uint8Array([78, 83, 67, 49])
const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

function frame(type: number, data: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(data.length + 5)
  bytes[0] = type
  new DataView(bytes.buffer).setUint32(1, data.length)
  bytes.set(data, 5)
  return bytes
}

export function componentFrames(
  metadata: unknown,
  value: unknown,
  maxBytes = COMPONENT_LIMITS.outputBytes,
): ReadableStream<Uint8Array> {
  const meta = encoder.encode(JSON.stringify(metadata))
  const body = encoder.encode(JSON.stringify(value))
  if (meta.length > COMPONENT_LIMITS.frameBytes || body.length + meta.length > maxBytes)
    throw new ServerComponentError("component_limit", 413)
  let position = -2
  return new ReadableStream({
    pull(controller) {
      if (position === -2) {
        controller.enqueue(magic)
        position++
        return
      }
      if (position === -1) {
        controller.enqueue(frame(1, meta))
        position++
        return
      }
      if (position < body.length) {
        const end = Math.min(body.length, position + 65536)
        controller.enqueue(frame(2, body.subarray(position, end)))
        position = end
        return
      }
      controller.enqueue(frame(3, new Uint8Array()))
      controller.close()
    },
  })
}

export interface DecodedComponentFrames {
  readonly metadata: unknown
  readonly value: unknown
}

export async function readComponentFrames(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  maxBytes = COMPONENT_LIMITS.outputBytes,
): Promise<DecodedComponentFrames> {
  const reader = stream.getReader()
  const header = new Uint8Array(5)
  let magicOffset = 0
  let headerOffset = 0
  let payload: Uint8Array | undefined
  let payloadOffset = 0
  let type = 0
  let metadata: unknown
  let gotMetadata = false
  let terminal = false
  let bytes = 0
  let bodyBytes = 0
  let metadataBytes = 0
  const body: Uint8Array[] = []
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(COMPONENT_LIMITS.operationMs)])
  const cancel = (): void => {
    void reader.cancel().catch(() => {
      /* The original read failure is authoritative. */
    })
  }
  deadline.addEventListener("abort", cancel, { once: true })
  const consume = (data: Uint8Array): void => {
    if (type === 1) {
      if (gotMetadata || bodyBytes !== 0) throw new ServerComponentError("component_protocol", 400)
      metadataBytes = data.length
      metadata = JSON.parse(decoder.decode(data))
      gotMetadata = true
    } else if (type === 2) {
      if (!gotMetadata || data.length === 0)
        throw new ServerComponentError("component_protocol", 400)
      bodyBytes += data.length
      if (bodyBytes + metadataBytes > maxBytes)
        throw new ServerComponentError("component_limit", 413)
      body.push(data)
    } else {
      if (!gotMetadata || bodyBytes === 0 || data.length !== 0)
        throw new ServerComponentError("component_protocol", 400)
      terminal = true
    }
  }
  try {
    while (true) {
      if (deadline.aborted)
        throw new ServerComponentError(
          signal.aborted ? "component_cancelled" : "component_timeout",
          504,
        )
      let timeout: ReturnType<typeof setTimeout> | undefined
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            reject(new ServerComponentError("component_timeout", 504))
            // Publish the timeout before cancellation can resolve reader.read() as ordinary EOF.
            cancel()
          }, COMPONENT_LIMITS.idleMs)
        }),
      ]).finally(() => clearTimeout(timeout))
      if (next.done) break
      if (terminal || next.value.length === 0)
        throw new ServerComponentError("component_protocol", 400)
      bytes += next.value.length
      if (bytes > maxBytes + 4096) throw new ServerComponentError("component_limit", 413)
      let offset = 0
      while (offset < next.value.length) {
        if (terminal) throw new ServerComponentError("component_protocol", 400)
        if (magicOffset < magic.length) {
          if (next.value[offset++] !== magic[magicOffset++])
            throw new ServerComponentError("component_protocol", 400)
          continue
        }
        if (headerOffset < header.length) {
          const size = Math.min(header.length - headerOffset, next.value.length - offset)
          header.set(next.value.subarray(offset, offset + size), headerOffset)
          offset += size
          headerOffset += size
          if (headerOffset < header.length) continue
          type = header[0]!
          const length = new DataView(header.buffer).getUint32(1)
          if (length > COMPONENT_LIMITS.frameBytes || ![1, 2, 3].includes(type))
            throw new ServerComponentError("component_protocol", 400)
          payload = new Uint8Array(length)
          payloadOffset = 0
        }
        // A frame allocates once. Arbitrarily split transport chunks are copied exactly once.
        const data = payload!
        const size = Math.min(data.length - payloadOffset, next.value.length - offset)
        data.set(next.value.subarray(offset, offset + size), payloadOffset)
        offset += size
        payloadOffset += size
        if (payloadOffset === data.length) {
          consume(data)
          headerOffset = 0
          payload = undefined
        }
      }
    }
    if (deadline.aborted)
      throw new ServerComponentError(
        signal.aborted ? "component_cancelled" : "component_timeout",
        504,
      )
    if (!terminal || headerOffset !== 0 || payload !== undefined)
      throw new ServerComponentError("component_protocol", 400)
    const merged = new Uint8Array(bodyBytes)
    let offset = 0
    for (const chunk of body) {
      merged.set(chunk, offset)
      offset += chunk.length
    }
    return { metadata, value: JSON.parse(decoder.decode(merged)) }
  } catch (error) {
    await reader.cancel().catch(() => {
      /* Preserve the first protocol/read failure. */
    })
    if (error instanceof ServerComponentError) throw error
    throw new ServerComponentError("component_protocol", 400)
  } finally {
    deadline.removeEventListener("abort", cancel)
    reader.releaseLock()
  }
}
