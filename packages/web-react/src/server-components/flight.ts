import { readComponentBytes } from "@nifrajs/web/server-components/stream"

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

/** React 19.2.8 Flight framing: remove development owners/stacks/console records before transport. */
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
  const bytes = publicFlight(await readComponentBytes(stream, signal))
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}
