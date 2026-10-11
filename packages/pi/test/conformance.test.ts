import { expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { checkAgentBackend } from "@nifrajs/agent-protocol/conformance"
import { PiBackend } from "../src/index.ts"

// "slow" waits for an abort, "approve" asks a confirm and finishes once it is answered.
const fakePi = `
let buffer = ""
const send = (record) => process.stdout.write(JSON.stringify(record) + "\\n")
const finish = (text) => {
  send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } })
  send({ type: "agent_end" })
}
process.stdin.on("data", (chunk) => {
  buffer += String(chunk)
  for (let newline = buffer.indexOf("\\n"); newline !== -1; newline = buffer.indexOf("\\n")) {
    const command = JSON.parse(buffer.slice(0, newline))
    buffer = buffer.slice(newline + 1)
    if (command.type === "prompt" && command.message === "approve")
      send({ type: "extension_ui_request", id: "confirm-1", method: "confirm", title: "write a.txt" })
    else if (command.type === "prompt" && command.message !== "slow") finish("done")
    else if (command.type === "extension_ui_response") finish(command.confirmed ? "written" : "skipped")
    else if (command.type === "abort") send({ type: "agent_end" })
  }
})
`

test("PiBackend passes the agent backend conformance kit", async () => {
  const report = await checkAgentBackend({
    backend: () => new PiBackend({ command: process.execPath, rpcArgs: ["-e", fakePi] }),
    cwd: tmpdir(),
    prompt: "hello",
    slowPrompt: "slow",
    approvalPrompt: "approve",
  })
  expect(report.checks.filter((check) => check.status !== "passed")).toEqual([])
  expect(report.backend).toBe("pi")
  expect(report.ok).toBe(true)
})
