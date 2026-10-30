import { ServerComponentError } from "./error.ts"
import { COMPONENT_LIMITS } from "./protocol.ts"

const magic = new Uint8Array([78, 83, 67, 49])
const flightMagic = new Uint8Array([78, 83, 70, 49])
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

export interface DecodedComponentFlightFrames {
  readonly metadata: unknown
  readonly flight: ReadableStream<Uint8Array>
}

/**
 * Stream a sanitized Flight body without first serializing it into a ComponentState JSON value.
 * Metadata is a single bounded frame; body chunks are bounded and pulled on downstream demand.
 */
export function componentFlightFrames(
  metadata: unknown,
  flight: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  maxBytes = COMPONENT_LIMITS.outputBytes,
): ReadableStream<Uint8Array> {
  const serialized = JSON.stringify(metadata)
  if (typeof serialized !== "string") throw new ServerComponentError("component_protocol", 400)
  const meta = encoder.encode(serialized)
  if (meta.length > COMPONENT_LIMITS.headerBytes)
    throw new ServerComponentError("component_limit", 413)

  const reader = flight.getReader()
  let stage = 0
  let pending: Uint8Array | undefined
  let pendingOffset = 0
  let bodyBytes = 0
  let closed = false
  let reading = false
  let released = false
  const releaseLock = (): void => {
    if (released || reading) return
    released = true
    try {
      reader.releaseLock()
    } catch {
      // Cancellation may race the final read; the closed reader is then left for collection.
    }
  }
  const release = (): void => {
    if (closed) return
    closed = true
    signal.removeEventListener("abort", cancelSource)
    releaseLock()
  }
  const read = () => {
    reading = true
    return reader.read().finally(() => {
      reading = false
      if (closed) releaseLock()
    })
  }
  const cancelSource = (): void => {
    void reader.cancel().catch(() => {
      /* The original stream failure or request abort is authoritative. */
    })
    release()
  }
  signal.addEventListener("abort", cancelSource, { once: true })

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (signal.aborted) throw new ServerComponentError("component_cancelled", 499)
        if (stage === 0) {
          controller.enqueue(flightMagic.slice())
          stage++
          return
        }
        if (stage === 1) {
          controller.enqueue(frame(1, meta))
          stage++
          return
        }
        while (true) {
          if (signal.aborted) throw new ServerComponentError("component_cancelled", 499)
          if (pending !== undefined) {
            const end = Math.min(pending.length, pendingOffset + 65_536)
            const chunk = pending.subarray(pendingOffset, end)
            pendingOffset = end
            if (end === pending.length) {
              pending = undefined
              pendingOffset = 0
            }
            controller.enqueue(frame(2, chunk))
            return
          }
          const next = await read()
          if (signal.aborted) throw new ServerComponentError("component_cancelled", 499)
          if (next.done) {
            if (bodyBytes === 0) throw new ServerComponentError("component_protocol", 400)
            controller.enqueue(frame(3, new Uint8Array()))
            controller.close()
            release()
            return
          }
          if (next.value.length === 0) throw new ServerComponentError("component_protocol", 400)
          bodyBytes += next.value.length
          if (bodyBytes > maxBytes) throw new ServerComponentError("component_limit", 413)
          pending = next.value
        }
      } catch (error) {
        cancelSource()
        try {
          controller.error(error)
        } finally {
          release()
        }
      }
    },
    async cancel() {
      cancelSource()
      release()
    },
  })
}

/** Read only the metadata eagerly. Flight bytes remain a bounded, demand-driven stream. */
export async function readComponentFlightFrames(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  maxBytes = COMPONENT_LIMITS.outputBytes,
): Promise<DecodedComponentFlightFrames> {
  const reader = stream.getReader()
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(COMPONENT_LIMITS.operationMs)])
  const maxFlightRows = 8_192
  const maxFrames = maxFlightRows + Math.ceil(maxBytes / 65_536) + 2
  const maxWireBytes =
    maxBytes + COMPONENT_LIMITS.headerBytes + maxFrames * 5 + flightMagic.length + 16
  let chunk: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
  let chunkOffset = 0
  let wireBytes = 0
  let frameCount = 0
  let bodyBytes = 0
  let cleaned = false
  let released = false
  let pendingRead: ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> | undefined

  const releaseLock = (): void => {
    if (released || pendingRead !== undefined) return
    released = true
    try {
      reader.releaseLock()
    } catch {
      // Cancellation may race the final read; the closed reader is then left for collection.
    }
  }

  const cleanup = (): void => {
    if (!cleaned) {
      cleaned = true
      deadline.removeEventListener("abort", abortDeadline)
    }
    releaseLock()
  }
  const abortReader = (): void => {
    void reader.cancel().catch(() => {
      /* The first read or protocol error is authoritative. */
    })
  }
  const abortDeadline = (): void => {
    abortReader()
    cleanup()
  }
  deadline.addEventListener("abort", abortDeadline, { once: true })

  const checkDeadline = (): void => {
    if (!deadline.aborted) return
    throw new ServerComponentError(
      signal.aborted ? "component_cancelled" : "component_timeout",
      signal.aborted ? 499 : 504,
    )
  }
  const readChunk = async () => {
    checkDeadline()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const next = await Promise.race([
        (() => {
          const pending = reader.read()
          pendingRead = pending
          return pending.finally(() => {
            if (pendingRead === pending) pendingRead = undefined
            if (cleaned) releaseLock()
          })
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new ServerComponentError("component_timeout", 504))
            abortReader()
          }, COMPONENT_LIMITS.idleMs)
        }),
      ])
      checkDeadline()
      return next
    } finally {
      clearTimeout(timer)
    }
  }
  const exact = async (length: number, eofAllowed = false): Promise<Uint8Array | undefined> => {
    const result = new Uint8Array(length)
    let offset = 0
    while (offset < length) {
      checkDeadline()
      if (chunkOffset === chunk.length) {
        const next = await readChunk()
        if (next.done) {
          if (eofAllowed && offset === 0) return undefined
          throw new ServerComponentError("component_protocol", 400)
        }
        if (next.value.length === 0) throw new ServerComponentError("component_protocol", 400)
        wireBytes += next.value.length
        if (wireBytes > maxWireBytes) throw new ServerComponentError("component_limit", 413)
        chunk = next.value
        chunkOffset = 0
      }
      const size = Math.min(length - offset, chunk.length - chunkOffset)
      result.set(chunk.subarray(chunkOffset, chunkOffset + size), offset)
      chunkOffset += size
      offset += size
    }
    return result
  }

  try {
    const header = await exact(flightMagic.length)
    if (!header || header.some((byte, index) => byte !== flightMagic[index]))
      throw new ServerComponentError("component_protocol", 400)
    const first = await exact(5)
    if (first?.[0] !== 1) throw new ServerComponentError("component_protocol", 400)
    frameCount++
    const metadataLength = new DataView(first.buffer).getUint32(1)
    if (metadataLength > COMPONENT_LIMITS.headerBytes)
      throw new ServerComponentError("component_limit", 413)
    const metadataBytes = await exact(metadataLength)
    if (!metadataBytes) throw new ServerComponentError("component_protocol", 400)
    let metadata: unknown
    try {
      metadata = JSON.parse(decoder.decode(metadataBytes))
    } catch {
      throw new ServerComponentError("component_protocol", 400)
    }

    let terminal = false
    const flight = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            while (!terminal) {
              checkDeadline()
              const nextHeader = await exact(5)
              if (!nextHeader) throw new ServerComponentError("component_protocol", 400)
              frameCount++
              if (frameCount > maxFrames) throw new ServerComponentError("component_limit", 413)
              const type = nextHeader[0]!
              const length = new DataView(nextHeader.buffer).getUint32(1)
              if (length > COMPONENT_LIMITS.frameBytes)
                throw new ServerComponentError("component_limit", 413)
              if (type === 2) {
                if (length === 0) throw new ServerComponentError("component_protocol", 400)
                bodyBytes += length
                if (bodyBytes > maxBytes) throw new ServerComponentError("component_limit", 413)
                const bytes = await exact(length)
                if (!bytes) throw new ServerComponentError("component_protocol", 400)
                controller.enqueue(bytes)
                return
              }
              if (type !== 3 || length !== 0 || bodyBytes === 0)
                throw new ServerComponentError("component_protocol", 400)
              terminal = true
              if ((await exact(1, true)) !== undefined)
                throw new ServerComponentError("component_protocol", 400)
              checkDeadline()
              cleanup()
              controller.close()
              return
            }
          } catch (error) {
            abortReader()
            try {
              controller.error(error)
            } finally {
              cleanup()
            }
          }
        },
        async cancel() {
          terminal = true
          abortReader()
          cleanup()
        },
      },
      { highWaterMark: 0 },
    )

    return { metadata, flight }
  } catch (error) {
    abortReader()
    cleanup()
    if (error instanceof ServerComponentError) throw error
    throw new ServerComponentError("component_protocol", 400)
  }
}
