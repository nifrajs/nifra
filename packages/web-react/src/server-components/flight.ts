import { COMPONENT_OUTPUT_LIMIT } from "@nifrajs/web/server-components/stream"

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })
function publicModel(value: unknown, depth = 0): unknown {
  if (depth > 128) throw new Error("component_limit")
  if (typeof value === "string" && value.startsWith("$F")) throw new Error("component_contract")
  if (Array.isArray(value))
    return (
      value[0] === "$"
        ? [...value.slice(0, 4), null, null, value[6] === 1 || value[6] === 2 ? value[6] : 0]
        : value
    ).map((item) => publicModel(item, depth + 1))
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, publicModel(item, depth + 1)]),
    )
  return value
}

/** React 19.3.1 Flight framing (unchanged from 19.2.8): remove development owners/stacks/console records before transport. */
export function publicFlight(bytes: Uint8Array): Uint8Array {
  const rows: Uint8Array[] = []
  let offset = 0
  while (offset < bytes.length) {
    const start = offset
    while (offset < bytes.length && bytes[offset] !== 58) offset++
    const id = decoder.decode(bytes.subarray(start, offset))
    if (!/^[0-9a-f]*$/.test(id) || offset === bytes.length) throw new Error("component_protocol")
    offset++
    if (bytes[offset] === 84) {
      const lengthStart = ++offset
      while (offset < bytes.length && bytes[offset] !== 44) offset++
      const encodedLength = decoder.decode(bytes.subarray(lengthStart, offset))
      if (!/^[0-9a-f]+$/.test(encodedLength)) throw new Error("component_protocol")
      const length = parseInt(encodedLength, 16)
      offset++
      if (offset + length > bytes.length) throw new Error("component_protocol")
      offset += length
      rows.push(bytes.slice(start, offset))
      continue
    }
    const end = bytes.indexOf(10, offset)
    if (end === -1) throw new Error("component_protocol")
    const row = decoder.decode(bytes.subarray(offset, end))
    offset = end + 1
    if (/^[DNW]/.test(row)) continue
    if (row.startsWith("E")) {
      rows.push(
        encoder.encode(
          id +
            ':E{"digest":"component_failed","message":"component_failed","name":"Error","stack":[],"env":"Server","owner":null}\n',
        ),
      )
      continue
    }
    if (/^[[{"0-9tnf-]/.test(row)) {
      let model: unknown
      try {
        model = JSON.parse(row)
      } catch {
        throw new Error("component_protocol")
      }
      rows.push(encoder.encode(`${id}:${JSON.stringify(publicModel(model))}\n`))
    } else rows.push(bytes.slice(start, offset))
  }
  const size = rows.reduce((size, row) => size + row.length, 0)
  const output = new Uint8Array(size)
  let at = 0
  for (const row of rows) {
    output.set(row, at)
    at += row.length
  }
  return output
}
export async function publicFlightStream(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const reader = stream.getReader()
  const maxBytes = COMPONENT_OUTPUT_LIMIT
  const maxRows = 8_192
  let buffer = new Uint8Array(1024)
  let start = 0
  let end = 0
  let inputBytes = 0
  let outputBytes = 0
  let outputRows = 0
  let rows = 0
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
    signal.removeEventListener("abort", abort)
    releaseLock()
  }
  const read = () => {
    reading = true
    return reader.read().finally(() => {
      reading = false
      if (closed) releaseLock()
    })
  }
  let cancellation: Promise<void> | undefined
  const cancel = (reason?: unknown): Promise<void> => {
    if (cancellation !== undefined) return cancellation
    cancellation = Promise.resolve()
      .then(() => reader.cancel(reason))
      .catch(() => {
        // The request abort or first stream failure is authoritative if source cleanup rejects.
      })
      .then(() => release())
    return cancellation
  }
  const abort = (): void => {
    void cancel(signal.reason)
  }
  const append = (chunk: Uint8Array): void => {
    const remaining = end - start
    const required = remaining + chunk.length
    if (required > maxBytes) throw new Error("component_limit")
    if (end + chunk.length > buffer.length && start > 0) {
      buffer.copyWithin(0, start, end)
      start = 0
      end = remaining
    }
    if (end + chunk.length > buffer.length) {
      let capacity = buffer.length
      while (capacity < end + chunk.length) capacity = Math.min(maxBytes, capacity * 2)
      if (capacity < end + chunk.length) throw new Error("component_limit")
      const grown = new Uint8Array(capacity)
      grown.set(buffer.subarray(start, end))
      buffer = grown
      start = 0
      end = remaining
    }
    buffer.set(chunk, end)
    end += chunk.length
  }
  const completeRowLength = (): number | undefined => {
    const available = end - start
    if (available === 0) return undefined
    const colon = buffer.indexOf(58, start)
    if (colon === -1 || colon >= end) {
      if (available > 128) throw new Error("component_protocol")
      return undefined
    }
    const id = decoder.decode(buffer.subarray(start, colon))
    if (!/^[0-9a-f]*$/.test(id)) throw new Error("component_protocol")
    const payloadStart = colon + 1
    if (payloadStart === end) return undefined
    if (buffer[payloadStart] === 84) {
      const comma = buffer.indexOf(44, payloadStart + 1)
      if (comma === -1 || comma >= end) {
        if (end - payloadStart > 16) throw new Error("component_protocol")
        return undefined
      }
      const encodedLength = decoder.decode(buffer.subarray(payloadStart + 1, comma))
      if (!/^[0-9a-f]{1,8}$/.test(encodedLength)) throw new Error("component_protocol")
      const length = Number.parseInt(encodedLength, 16)
      if (!Number.isSafeInteger(length) || length > maxBytes) throw new Error("component_limit")
      const rowEnd = comma + 1 + length
      return rowEnd <= end ? rowEnd - start : undefined
    }
    const newline = buffer.indexOf(10, payloadStart)
    if (newline === -1 || newline >= end) {
      if (available > maxBytes) throw new Error("component_limit")
      return undefined
    }
    return newline + 1 - start
  }
  const takeRow = (length: number): Uint8Array => {
    const row = buffer.slice(start, start + length)
    start += length
    if (start === end) {
      start = 0
      end = 0
    } else if (start >= buffer.length / 2) {
      buffer.copyWithin(0, start, end)
      end -= start
      start = 0
    }
    return row
  }

  signal.addEventListener("abort", abort, { once: true })
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          while (true) {
            if (signal.aborted) throw new Error("component_cancelled")
            const length = completeRowLength()
            if (length !== undefined) {
              if (++rows > maxRows) throw new Error("component_limit")
              const safe = publicFlight(takeRow(length))
              outputBytes += safe.length
              if (outputBytes > maxBytes) throw new Error("component_limit")
              if (safe.length > 0) {
                outputRows++
                controller.enqueue(safe)
                return
              }
              continue
            }
            const next = await read()
            if (signal.aborted) throw new Error("component_cancelled")
            if (next.done) {
              if (end !== start) throw new Error("component_protocol")
              if (outputRows === 0) throw new Error("component_protocol")
              controller.close()
              release()
              return
            }
            if (next.value.length === 0) throw new Error("component_protocol")
            inputBytes += next.value.length
            if (inputBytes > maxBytes) throw new Error("component_limit")
            append(next.value)
          }
        } catch (error) {
          await cancel(error)
          try {
            controller.error(error)
          } finally {
            release()
          }
        }
      },
      cancel(reason) {
        return cancel(reason)
      },
    },
    { highWaterMark: 0 },
  )
}
