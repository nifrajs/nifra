import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentEvent } from "@nifrajs/agent-protocol"
import { PiBackend, type PiBackendOptions } from "../src/index.ts"

type Line = object | string | { readonly raw: string }

/**
 * A stand-in Pi that answers each prompt, and each reload, with fixed JSONL. A string is written as
 * one raw line, `{ raw }` without its newline, and `after` runs once the answer is written.
 */
function fakePi(
  onPrompt: readonly Line[],
  options: { readonly onReload?: readonly Line[]; readonly after?: string } = {},
): string {
  const encode = (lines: readonly Line[]) =>
    JSON.stringify(
      lines.map((line) =>
        typeof line === "string"
          ? `${line}\n`
          : "raw" in line && typeof line.raw === "string"
            ? line.raw
            : `${JSON.stringify(line)}\n`,
      ),
    )
  return `
const prompt = ${encode(onPrompt)}
const reload = ${encode(options.onReload ?? [])}
let buffer = ""
process.stdin.on("data", (chunk) => {
  buffer += String(chunk)
  for (;;) {
    const newline = buffer.indexOf("\\n")
    if (newline === -1) break
    const command = JSON.parse(buffer.slice(0, newline))
    buffer = buffer.slice(newline + 1)
    const isReload = command.type === "reload" || command.message === "/reload"
    const out = isReload ? reload : command.type === "prompt" ? prompt : []
    for (const text of out) process.stdout.write(text)
    ${options.after ?? ""}
  }
})
setInterval(() => {}, 1000)
`
}

async function turn(
  backend: PiBackend,
  sessionId: string,
  message = "hello",
  options: { readonly signal?: AbortSignal } = {},
): Promise<{ events: AgentEvent[]; error?: unknown }> {
  const events: AgentEvent[] = []
  try {
    for await (const event of backend.send({
      sessionId,
      message,
      ...options,
    }))
      events.push(event)
    return { events }
  } catch (error) {
    return { events, error }
  }
}

async function withPi(
  script: string,
  options: Omit<PiBackendOptions, "command" | "rpcArgs">,
  run: (backend: PiBackend, sessionId: string) => Promise<void>,
): Promise<void> {
  const backend = new PiBackend({ command: process.execPath, rpcArgs: ["-e", script], ...options })
  const sessionId = `records-${crypto.randomUUID()}`
  await backend.createSession({ cwd: process.cwd(), sessionId })
  try {
    await run(backend, sessionId)
  } finally {
    await backend.close(sessionId).catch(() => undefined)
  }
}

const ofType = <T extends AgentEvent["type"]>(events: readonly AgentEvent[], type: T) =>
  events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type)

describe("Pi backend bounds", () => {
  test("the constructor refuses out-of-range record, message and queue limits", () => {
    expect(() => new PiBackend({ maxRecordBytes: 512 })).toThrow(
      "maxRecordBytes must be between 1024",
    )
    expect(() => new PiBackend({ maxMessageChars: 10 })).toThrow(
      "maxMessageChars must be between 256",
    )
    expect(() => new PiBackend({ maxEventQueueSize: 0 })).toThrow(
      "maxEventQueueSize must be between 1",
    )
  })

  test("createSession refuses an empty cwd, odd capabilities and an unbounded id", async () => {
    const backend = new PiBackend({ command: process.execPath, rpcArgs: ["-e", ""] })
    await expect(backend.createSession({ cwd: "" })).rejects.toThrow(
      "cwd must be a bounded non-empty path",
    )
    await expect(
      backend.createSession({ cwd: process.cwd(), capabilities: ["not a token"] }),
    ).rejects.toThrow("capabilities must be bounded tokens")
    await expect(
      backend.createSession({ cwd: process.cwd(), sessionId: "not valid" }),
    ).rejects.toThrow("sessionId must be a bounded token")
  })

  test("a message past maxMessageChars fails before Pi sees it", () =>
    withPi(fakePi([]), { maxMessageChars: 256 }, async (backend, id) => {
      const { error } = await turn(backend, id, "x".repeat(257))
      expect(error).toMatchObject({ code: "MESSAGE_BOUNDED" })
    }))
})

describe("Pi record mapping", () => {
  test("tool results, compaction, reload notices and errors map to protocol events", () =>
    withPi(
      fakePi([
        { type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "a" } },
        { type: "tool_execution_end", toolCallId: "c1", toolName: "read" },
        {
          type: "tool_execution_end",
          toolCallId: "c2",
          toolName: "write",
          isError: true,
          result: { content: [{ type: "text", text: "denied" }] },
        },
        {
          type: "compaction_end",
          reason: "manual",
          result: { tokensBefore: 10, estimatedTokensAfter: 4 },
        },
        { type: "compaction_end", reason: "odd", result: { tokensBefore: -1 } },
        {
          type: "extension_reloaded",
          data: { revision: "r9", loaded: ["a"], disabled: ["b"], rolledBack: false },
        },
        { type: "session_compact" },
        { type: "extension_error" },
        { type: "agent_settled" },
      ]),
      {},
      async (backend, id) => {
        const { events, error } = await turn(backend, id)
        expect(error).toBeUndefined()
        expect(
          ofType(events, "tool.completed").map(({ callId, ok, output, error }) => ({
            callId,
            ok,
            output,
            code: error?.code,
          })),
        ).toEqual([
          { callId: "c1", ok: true, output: undefined, code: undefined },
          { callId: "c2", ok: false, output: "denied", code: "PI_TOOL_FAILED" },
        ])
        expect(
          ofType(events, "memory.compacted").map(({ before, after, reason }) => [
            before,
            after,
            reason,
          ]),
        ).toEqual([
          [10, 4, "manual"],
          [0, 0, "workflow"],
        ])
        expect(ofType(events, "extension.reloaded")).toMatchObject([
          { revision: "r9", loaded: ["a"], disabled: ["b"], rolledBack: false },
        ])
        expect(ofType(events, "session.failed")).toMatchObject([
          { error: { code: "PI_EXTENSION", message: "Pi extension failed" }, recoverable: true },
        ])
        expect(events.at(-1)?.type).toBe("session.completed")
      },
    ))

  test("an approval title past its bound is cut, and a full approval queue fails the turn", () =>
    withPi(
      fakePi(
        Array.from({ length: 129 }, (_, index) => ({
          type: "extension_ui_request",
          id: `confirm-${index}`,
          method: "confirm",
          title: index === 0 ? "t".repeat(600) : "Allow",
        })),
      ),
      {},
      async (backend, id) => {
        const { events, error } = await turn(backend, id)
        const approvals = ofType(events, "approval.required")
        expect(approvals).toHaveLength(128)
        expect(approvals[0]?.action).toBe(`${"t".repeat(511)}…`)
        expect(error).toMatchObject({ code: "PI_PROTOCOL", message: "Pi approval queue is full" })
      },
    ))

  test("an event outside protocol bounds fails the turn", () =>
    withPi(
      fakePi([{ type: "tool_execution_start", toolCallId: "c1", toolName: "x".repeat(300) }]),
      {},
      async (backend, id) => {
        const { error } = await turn(backend, id)
        expect(error).toMatchObject({
          code: "PI_PROTOCOL",
          message: "Pi emitted an event outside protocol bounds",
        })
      },
    ))

  test("a command Pi refuses fails the turn with its name", () =>
    withPi(
      fakePi([{ type: "response", command: "prompt", success: false }]),
      {},
      async (backend, id) => {
        const { error } = await turn(backend, id)
        expect(error).toMatchObject({
          code: "PI_COMMAND_FAILED",
          message: "Pi command failed: prompt",
        })
      },
    ))
})

describe("Pi output framing", () => {
  test("a line that is not JSON fails the turn", () =>
    withPi(fakePi(["not json"]), {}, async (backend, id) => {
      expect((await turn(backend, id)).error).toMatchObject({
        code: "PI_PROTOCOL",
        message: "Pi emitted invalid JSONL",
      })
    }))

  test("a partial record past the cap fails the turn before its newline arrives", () =>
    withPi(fakePi([{ raw: "x".repeat(2_000) }]), { maxRecordBytes: 1_024 }, async (backend, id) => {
      expect((await turn(backend, id)).error).toMatchObject({
        code: "PI_PROTOCOL",
        message: "Pi emitted an oversized JSONL record",
      })
    }))

  test("output that ends inside a record fails the turn", () =>
    withPi(
      // Closing fd 1 ends Pi's output while the process lives on, so only the framing can fail.
      fakePi([], {
        after: `if (command.type === "prompt") { const fs = require("node:fs"); fs.writeSync(1, '{"type":"agent'); fs.closeSync(1) }`,
      }),
      {},
      async (backend, id) => {
        expect((await turn(backend, id)).error).toMatchObject({
          code: "PI_PROTOCOL",
          message: "Pi emitted an unterminated JSONL record",
        })
      },
    ))
})

describe("Pi session lifecycle", () => {
  test("a Pi that exits mid-turn fails it, and the closed session refuses a reload", () =>
    withPi(
      fakePi([], { after: 'if (command.type === "prompt") process.exit(3)' }),
      {},
      async (backend, id) => {
        expect((await turn(backend, id)).error).toMatchObject({
          code: "PI_EXITED",
          message: "Pi exited with code 3",
        })
        expect(await backend.reload(id)).toMatchObject({
          revision: "closed",
          error: { code: "SESSION_CLOSED" },
        })
        await backend.close(id)
        await expect(backend.snapshot(id)).rejects.toThrow("unknown session")
      },
    ))

  test("a reload while a turn runs is refused, and an abort signal stops the turn", () =>
    withPi(fakePi([]), {}, async (backend, id) => {
      const controller = new AbortController()
      const running = turn(backend, id, "hello", { signal: controller.signal })
      expect(await backend.reload(id)).toMatchObject({ error: { code: "SESSION_BUSY" } })
      controller.abort()
      const { events, error } = await running
      expect(error).toBeUndefined()
      expect(events.at(-1)).toMatchObject({ type: "session.stopped", reason: "cancelled" })
    }))

  test("a prompt reload takes Pi's answer as a new revision", () =>
    withPi(
      fakePi([], { onReload: [{ type: "response", command: "prompt", success: true }] }),
      { reloadCommand: "prompt" },
      async (backend, id) => {
        expect(await backend.reload(id)).toEqual({
          revision: "pi:1",
          loaded: [],
          disabled: [],
          rolledBack: false,
        })
        expect((await backend.snapshot(id)).extensionRevision).toBe("pi:1")
      },
    ))

  test("an rpc reload Pi refuses reports the failure", () =>
    withPi(
      fakePi([], { onReload: [{ type: "response", command: "reload", success: false }] }),
      { reloadCommand: "rpc" },
      async (backend, id) => {
        expect(await backend.reload(id)).toMatchObject({
          revision: "unchanged",
          error: { code: "PI_COMMAND_FAILED" },
        })
      },
    ))

  test("an rpc reload that ends without a notice keeps the revision unknown", () =>
    withPi(
      fakePi([], { onReload: [{ type: "agent_end" }] }),
      { reloadCommand: "rpc" },
      async (backend, id) => {
        expect(await backend.reload(id)).toEqual({
          revision: "unknown",
          loaded: [],
          disabled: [],
          rolledBack: false,
        })
      },
    ))
})

describe("Pi launch", () => {
  let root = ""
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "nifra-pi-launch-"))
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  // A shell stand-in reports the arguments Pi was started with; Windows has no sh to run it.
  test.skipIf(process.platform === "win32")(
    "the default launch passes Pi its RPC mode, session and extension flags",
    async () => {
      const command = join(root, "fake-pi")
      await writeFile(
        command,
        `#!/bin/sh
args="$*"
while IFS= read -r line; do
  case "$line" in *'"prompt"'*) printf '{"type":"message_end","message":{"role":"assistant","content":"%s"}}\\n{"type":"agent_end"}\\n' "$args";; esac
done
`,
      )
      await chmod(command, 0o755)
      const launched = async (options: PiBackendOptions, sessionId: string) => {
        const backend = new PiBackend({ command, ...options })
        await backend.createSession({ cwd: root, sessionId })
        try {
          const { events } = await turn(backend, sessionId)
          return ofType(events, "assistant.message")
            .map((event) => event.text)
            .join("")
        } finally {
          await backend.close(sessionId)
        }
      }
      const plain = await launched({}, "launch-plain")
      expect(plain).toStartWith("--mode rpc --no-session --extension ")
      expect(plain).toEndWith("reload.ts")
      const full = await launched(
        {
          noSession: false,
          sessionDir: join(root, "sessions"),
          appendSystemPrompt: "be-brief",
          enableReloadBridge: false,
          enableNifraTools: true,
          args: ["--extra"],
        },
        "launch-full",
      )
      expect(full).toStartWith(
        `--mode rpc --session-dir ${join(root, "sessions")} --session-id launch-full --append-system-prompt be-brief --extension `,
      )
      expect(full).toEndWith("nifra.ts --extra")
    },
  )

  test("on Windows a provider key set in another case still reaches Pi", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")
    const saved = process.env.XAI_API_KEY
    delete process.env.XAI_API_KEY
    process.env.xai_api_key = "lower-case-key"
    const backend = new PiBackend({
      command: process.execPath,
      rpcArgs: [
        "-e",
        `process.stdin.on("data", (chunk) => {
  if (!String(chunk).includes("prompt")) return
  const seen = process.env.XAI_API_KEY === "lower-case-key" ? "forwarded" : "absent"
  process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: seen } }) + "\\n")
  process.stdout.write(JSON.stringify({ type: "agent_end" }) + "\\n")
})`,
      ],
    })
    try {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true })
      // The environment is built and the process spawned in createSession's synchronous part.
      const creating = backend.createSession({ cwd: process.cwd(), sessionId: "windows-env" })
      if (platform !== undefined) Object.defineProperty(process, "platform", platform)
      await creating
      const { events } = await turn(backend, "windows-env")
      expect(ofType(events, "assistant.message")[0]?.text).toBe("forwarded")
    } finally {
      if (platform !== undefined) Object.defineProperty(process, "platform", platform)
      delete process.env.xai_api_key
      if (saved !== undefined) process.env.XAI_API_KEY = saved
      await backend.close("windows-env").catch(() => undefined)
    }
  })
})
