/** The pre-built text frame a Node publish writes straight to each idle subscriber. */
import { afterEach, expect, test } from "bun:test"
import { createServer, type Server, Socket } from "node:net"
import { textFrame, writeTextFrame } from "../src/ws-frame.ts"

const servers: Server[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

/** A connected client socket and every byte its peer receives. */
async function socketPair(): Promise<{ client: Socket; received: () => Promise<Buffer> }> {
  const chunks: Buffer[] = []
  let ended: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    ended = resolve
  })
  const server = createServer((peer) => {
    peer.on("data", (chunk: Buffer) => chunks.push(chunk))
    peer.on("end", () => ended())
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const port = typeof address === "object" && address !== null ? address.port : 0
  const client = new Socket()
  await new Promise<void>((resolve) => client.connect(port, "127.0.0.1", resolve))
  return {
    client,
    received: async () => {
      client.end()
      await done
      return Buffer.concat(chunks)
    },
  }
}

const idleSender = () => ({ _state: 0, _queue: [] })

test("a text frame is final, unmasked and sized for every length class", () => {
  const cases: [number, number[]][] = [
    [5, [0x81, 5]],
    [200, [0x81, 126, 0, 200]],
    [70_000, [0x81, 127, 0, 0, 0, 0, 0, 1, 0x11, 0x70]],
  ]
  for (const [length, head] of cases) {
    const text = "a".repeat(length)
    const frame = textFrame(text)
    expect([...frame.subarray(0, head.length)]).toEqual([...head])
    expect(frame.subarray(head.length).toString()).toBe(text)
  }
})

test("a publish frames its text once: the same bytes go to every subscriber", () => {
  expect(textFrame("same")).toBe(textFrame("same"))
  expect(textFrame("other")).not.toBe(textFrame("same"))
})

test("the frame goes straight to an idle socket; anything else is left to ws", async () => {
  const { client, received } = await socketPair()
  const ws = (sender: unknown, socket: unknown = client, readyState = 1) => ({
    readyState,
    _sender: sender,
    _socket: socket,
  })
  expect(writeTextFrame(ws(idleSender(), client, 2), "x")).toBe(false)
  expect(writeTextFrame(ws(null), "x")).toBe(false)
  expect(writeTextFrame(ws({ _state: 1, _queue: [] }), "x")).toBe(false)
  expect(writeTextFrame(ws({ _state: 0, _queue: ["queued"] }), "x")).toBe(false)
  expect(writeTextFrame(ws(idleSender(), {}), "x")).toBe(false)
  const dead = new Socket()
  dead.destroy()
  expect(writeTextFrame(ws(idleSender(), dead), "x")).toBe(false)
  expect(writeTextFrame(ws(idleSender()), "hello")).toBe(true)
  expect(await received()).toEqual(textFrame("hello"))
})
