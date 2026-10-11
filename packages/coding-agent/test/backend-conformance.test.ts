import { expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { checkAgentBackend } from "@nifrajs/agent-protocol/conformance"
import { type NativeModelRequest, NifraBackend } from "../src/native.ts"

function lastUserText(request: NativeModelRequest): string {
  return request.messages.findLast((message) => message.role === "user")?.text ?? ""
}

function nativeBackend(): NifraBackend {
  return new NifraBackend({
    model: {
      complete: (request) => {
        const text = lastUserText(request)
        if (text === "slow")
          return new Promise((_resolve, reject) =>
            request.signal.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            }),
          )
        if (text === "approve" && !request.messages.some((message) => message.role === "tool"))
          return { type: "tool", name: "write_file", input: { path: "a.txt" } }
        return { type: "text", text: "done" }
      },
    },
    tools: [
      {
        name: "write_file",
        description: "Write a file",
        capabilities: ["filesystem.write"],
        requiresApproval: true,
        execute: () => "written",
      },
    ],
  })
}

test("NifraBackend passes the agent backend conformance kit", async () => {
  const report = await checkAgentBackend({
    backend: nativeBackend,
    cwd: tmpdir(),
    prompt: "hello",
    slowPrompt: "slow",
    approvalPrompt: "approve",
  })
  expect(report.checks.filter((check) => check.status !== "passed")).toEqual([])
  expect(report.backend).toBe("nifra")
  expect(report.ok).toBe(true)
})
