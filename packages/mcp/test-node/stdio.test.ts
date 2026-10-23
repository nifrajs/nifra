/**
 * `serveStdio` on Node itself, with its default streams: a child `node` process serves a built
 * `@nifrajs/mcp` server over its own stdin/stdout, the test writes two requests, closes stdin, and reads
 * both answers back before the child exits on its own.
 */

import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { join } from "node:path"
import { test } from "node:test"

test("serveStdio answers over process.stdin/stdout and exits when stdin ends", async () => {
  const child = spawn(process.execPath, [join(import.meta.dirname, "fixtures/stdio-server.mjs")], {
    stdio: ["pipe", "pipe", "inherit"],
  })
  let stdout = ""
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk
  })
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`)
  child.stdin.end(
    `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { on: "node" } } })}\n`,
  )
  const [exitCode] = await once(child, "exit")
  assert.equal(exitCode, 0)
  const messages = stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line))
  assert.deepEqual(
    messages.map((message) => message.id),
    [1, 2],
  )
  assert.deepEqual(messages[1].result.content, [{ type: "text", text: '{"on":"node"}' }])
})
