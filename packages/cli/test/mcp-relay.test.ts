import { expect, test } from "bun:test"
import type { StdioMessage } from "@nifrajs/mcp/stdio"
import type { JsonRpcRequest } from "../src/mcp-protocol.ts"
import { startRelay } from "../src/mcp-relay.ts"

// The child stands in for the project's CLI: it answers the replayed `initialize`, then behaves as the
// script says. The relay must carry whole lines through and never hold an unbounded one.

const CHILD = `
const reader = Bun.stdin.stream().getReader()
let text = ""
const decoder = new TextDecoder()
const next = async () => {
  while (!text.includes("\\n")) {
    const { value, done } = await reader.read()
    if (done) process.exit(0)
    text += decoder.decode(value, { stream: true })
  }
  const at = text.indexOf("\\n")
  const line = text.slice(0, at)
  text = text.slice(at + 1)
  return JSON.parse(line)
}
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n")
const init = await next()
send({ jsonrpc: "2.0", id: init.id, result: { ok: true } })
const mode = process.env.RELAY_TEST_MODE
const request = await next()
if (mode === "echo") {
  send({ jsonrpc: "2.0", id: request.id, result: { padding: "x".repeat(Number(process.env.RELAY_TEST_SIZE)) } })
  await next()
}
if (mode === "unterminated") {
  process.stdout.write("x".repeat(Number(process.env.RELAY_TEST_SIZE)))
  await next()
}
`

const initialize: JsonRpcRequest = { jsonrpc: "2.0", id: 1, method: "initialize" }
const ask: JsonRpcRequest = { jsonrpc: "2.0", id: 2, method: "ping" }

const start = (mode: string, size: number, maxFrameBytes: number) => {
  const sent: StdioMessage[] = []
  const relay = startRelay({
    command: [process.execPath, "-e", CHILD],
    cwd: import.meta.dir,
    env: { ...process.env, RELAY_TEST_MODE: mode, RELAY_TEST_SIZE: String(size) },
    initialize,
    initialized: false,
    send: (message) => sent.push(message),
    announce: "relay test",
    maxFrameBytes,
  })
  return { relay, sent }
}

test("a line under the cap, however many chunks it arrives in, is relayed whole", async () => {
  const { relay } = start("echo", 300_000, 1_000_000)
  const started = await relay
  expect(started).toBeDefined()
  const response = await started?.request(ask)
  expect(response).toMatchObject({ id: 2, result: { padding: "x".repeat(300_000) } })
  await started?.close()
})

test("a line over the cap ends the child and answers the waiting request with an error", async () => {
  const { relay } = start("echo", 300_000, 100_000)
  const started = await relay
  expect(started).toBeDefined()
  const response = await started?.request(ask)
  expect(response).toMatchObject({ id: 2, error: { code: -32603 } })
  expect(started?.alive).toBe(false)
})

test("a child that never ends its line is ended at the cap instead of being buffered", async () => {
  const { relay } = start("unterminated", 4_000_000, 65_536)
  const started = await relay
  expect(started).toBeDefined()
  const response = await started?.request(ask)
  expect(response).toMatchObject({ id: 2, error: { code: -32603 } })
  expect(started?.alive).toBe(false)
})
