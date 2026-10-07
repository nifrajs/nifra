import { describe, expect, test } from "bun:test"
import registerNifraTools from "../extensions/nifra.ts"
import { PiBackend } from "../src/index.ts"

const fakePi = `
let buffer = ""
process.stdin.on("data", (chunk) => {
  buffer += String(chunk)
  for (;;) {
    const newline = buffer.indexOf("\\n")
    if (newline === -1) break
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    const command = JSON.parse(line)
    if (command.type === "prompt") {
      process.stdout.write(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ok" } }) + "\\n")
      process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }) + "\\n")
      process.stdout.write(JSON.stringify({ type: "agent_end" }) + "\\n")
      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n")
    }
  }
})
`

/** A fake Pi that answers every prompt with the given RPC records. */
function scriptedPi(records: readonly unknown[]): string {
  return `
process.stdin.on("data", (chunk) => {
  if (!String(chunk).includes("prompt")) return
  for (const record of ${JSON.stringify(records)}) process.stdout.write(JSON.stringify(record) + "\\n")
})
`
}

// Recorded from `pi --mode rpc` 0.84.1 with an expired ChatGPT login.
const expiredLoginMessage = {
  role: "assistant",
  content: [],
  api: "openai-codex-responses",
  provider: "openai-codex",
  model: "gpt-5.6-luna",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "error",
  errorMessage:
    'OAuth refresh failed for openai-codex: OpenAI Codex token refresh failed (401): {\n  "error": {\n    "message": "Could not validate your refresh token. Please try signing in again.",\n    "type": "invalid_request_error",\n    "param": null,\n    "code": "invalid_refresh_token"\n  }\n}',
  timestamp: 1791366339228,
}

describe("PiBackend", () => {
  async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
    const values: T[] = []
    for await (const value of source) values.push(value)
    return values
  }

  async function collectUntilSettled<T>(
    source: AsyncIterable<T>,
  ): Promise<{ events: T[]; error: unknown }> {
    const events: T[] = []
    try {
      for await (const value of source) events.push(value)
      return { events, error: undefined }
    } catch (error) {
      return { events, error }
    }
  }

  test("a failed model call fails the turn with a sign-in code and only the first line", async () => {
    const backend = new PiBackend({
      command: process.execPath,
      rpcArgs: [
        "-e",
        scriptedPi([
          { type: "agent_start" },
          { type: "message_start", message: expiredLoginMessage },
          { type: "message_end", message: expiredLoginMessage },
          { type: "turn_end", message: expiredLoginMessage, toolResults: [] },
          { type: "agent_end", messages: [expiredLoginMessage], willRetry: false },
          { type: "agent_settled" },
        ]),
      ],
    })
    try {
      await backend.createSession({ cwd: process.cwd(), sessionId: "model-failed" })
      const { events, error } = await collectUntilSettled(
        backend.send({ sessionId: "model-failed", message: "hi" }),
      )
      const expected = {
        code: "PI_AUTH_REQUIRED",
        message: "OAuth refresh failed for openai-codex: OpenAI Codex token refresh failed (401)",
      }
      expect(events.map((event) => event.type)).toEqual([
        "session.updated",
        "turn.started",
        "session.updated",
        "session.failed",
      ])
      expect(events.at(-1)).toMatchObject({ error: expected, recoverable: true })
      expect(error).toEqual(expected)
      expect((await backend.snapshot("model-failed")).status).toBe("failed")
    } finally {
      await backend.close("model-failed")
    }
  })

  test("a model error without an auth cause reports PI_MODEL_FAILED", async () => {
    const overloaded = {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage:
        '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    }
    const backend = new PiBackend({
      command: process.execPath,
      rpcArgs: [
        "-e",
        scriptedPi([
          { type: "message_end", message: overloaded },
          { type: "agent_end", willRetry: false },
        ]),
      ],
    })
    try {
      await backend.createSession({ cwd: process.cwd(), sessionId: "model-overloaded" })
      const { events, error } = await collectUntilSettled(
        backend.send({ sessionId: "model-overloaded", message: "hi" }),
      )
      expect(events.at(-1)).toMatchObject({
        type: "session.failed",
        error: { code: "PI_MODEL_FAILED", message: overloaded.errorMessage },
        recoverable: true,
      })
      expect(error).toMatchObject({ code: "PI_MODEL_FAILED" })
    } finally {
      await backend.close("model-overloaded")
    }
  })

  test("a model error Pi retries does not end the turn", async () => {
    const backend = new PiBackend({
      command: process.execPath,
      rpcArgs: [
        "-e",
        scriptedPi([
          {
            type: "message_end",
            message: { role: "assistant", content: [], stopReason: "error", errorMessage: "529" },
          },
          { type: "agent_end", willRetry: true },
          { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 0, errorMessage: "529" },
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "ok" }],
              stopReason: "stop",
            },
          },
          { type: "auto_retry_end", success: true, attempt: 1 },
          { type: "agent_end", willRetry: false },
          { type: "agent_settled" },
        ]),
      ],
    })
    try {
      await backend.createSession({ cwd: process.cwd(), sessionId: "model-retried" })
      const events = await collect(backend.send({ sessionId: "model-retried", message: "hi" }))
      expect(events.map((event) => event.type)).toEqual([
        "session.updated",
        "turn.started",
        "assistant.message",
        "session.updated",
        "session.completed",
      ])
    } finally {
      await backend.close("model-retried")
    }
  })

  test("a model call Pi aborts stops the turn instead of completing it", async () => {
    const backend = new PiBackend({
      command: process.execPath,
      rpcArgs: [
        "-e",
        scriptedPi([
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [],
              stopReason: "aborted",
              errorMessage: "Request was aborted",
            },
          },
          { type: "agent_end", willRetry: false },
        ]),
      ],
    })
    try {
      await backend.createSession({ cwd: process.cwd(), sessionId: "model-aborted" })
      const events = await collect(backend.send({ sessionId: "model-aborted", message: "hi" }))
      expect(events.at(-1)).toMatchObject({ type: "session.stopped", reason: "aborted" })
      expect(events.some((event) => event.type === "session.completed")).toBe(false)
      expect((await backend.snapshot("model-aborted")).status).toBe("stopped")
    } finally {
      await backend.close("model-aborted")
    }
  })

  test("maps Pi JSONL events into the Nifra protocol", async () => {
    const backend = new PiBackend({ command: process.execPath, rpcArgs: ["-e", fakePi] })
    const snapshot = await backend.createSession({ cwd: process.cwd(), sessionId: "test" })
    expect(snapshot.backend).toBe("pi")
    const events = []
    for await (const event of backend.send({ sessionId: "test", message: "hello" }))
      events.push(event)
    expect(events.some((event) => event.type === "assistant.delta")).toBe(true)
    expect(events.some((event) => event.type === "session.completed")).toBe(true)
    expect((await backend.snapshot("test")).status).toBe("idle")
    await backend.close("test")
  })

  test("an explicit undefined environment override does not inherit the parent value", async () => {
    const key = "NIFRA_PI_FILTER_TEST"
    const previous = process.env[key]
    process.env[key] = "must-not-leak"
    const script = `
process.stdin.on("data", (chunk) => {
  if (!String(chunk).includes("prompt")) return
  process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: process.env.${key} || "absent" }] } }) + "\\n")
  process.stdout.write(JSON.stringify({ type: "agent_end" }) + "\\n")
})
`
    const backend = new PiBackend({
      command: process.execPath,
      rpcArgs: ["-e", script],
      env: { [key]: undefined },
    })
    try {
      await backend.createSession({ cwd: process.cwd(), sessionId: "env-filter" })
      const events = await collect(backend.send({ sessionId: "env-filter", message: "hello" }))
      expect(events.find((event) => event.type === "assistant.message")).toMatchObject({
        text: "absent",
      })
    } finally {
      await backend.close("env-filter")
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    }
  })

  test("model-provider credentials reach Pi and other parent variables do not", async () => {
    const saved = { key: process.env.ANTHROPIC_API_KEY, other: process.env.NIFRA_PI_UNRELATED }
    process.env.ANTHROPIC_API_KEY = "sk-forwarded"
    process.env.NIFRA_PI_UNRELATED = "must-not-leak"
    const script = `
process.stdin.on("data", (chunk) => {
  if (!String(chunk).includes("prompt")) return
  const text = (process.env.ANTHROPIC_API_KEY || "absent") + "|" + (process.env.NIFRA_PI_UNRELATED || "absent")
  process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } }) + "\\n")
  process.stdout.write(JSON.stringify({ type: "agent_end" }) + "\\n")
})
`
    const backend = new PiBackend({ command: process.execPath, rpcArgs: ["-e", script] })
    try {
      await backend.createSession({ cwd: process.cwd(), sessionId: "env-provider" })
      const events = await collect(backend.send({ sessionId: "env-provider", message: "hello" }))
      expect(events.find((event) => event.type === "assistant.message")).toMatchObject({
        text: "sk-forwarded|absent",
      })
    } finally {
      await backend.close("env-provider")
      for (const [name, value] of [
        ["ANTHROPIC_API_KEY", saved.key],
        ["NIFRA_PI_UNRELATED", saved.other],
      ] as const) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  test("rejects malformed and oversized Pi JSONL records without throwing from the reader", async () => {
    const fakeMalformed = `
process.stdin.on("data", (chunk) => {
  if (String(chunk).includes("prompt")) process.stdout.write("null\\n")
})
`
    const malformed = new PiBackend({
      command: process.execPath,
      rpcArgs: ["-e", fakeMalformed],
    })
    await malformed.createSession({ cwd: process.cwd(), sessionId: "malformed-jsonl" })
    await expect(
      collect(malformed.send({ sessionId: "malformed-jsonl", message: "hello" })),
    ).rejects.toMatchObject({ code: "PI_PROTOCOL" })
    await malformed.close("malformed-jsonl")

    const fakeOversized = `
process.stdin.on("data", (chunk) => {
  if (String(chunk).includes("prompt")) process.stdout.write(JSON.stringify("${"x".repeat(2_000)}") + "\\n")
})
`
    const oversized = new PiBackend({
      command: process.execPath,
      rpcArgs: ["-e", fakeOversized],
      maxRecordBytes: 1_024,
    })
    await oversized.createSession({ cwd: process.cwd(), sessionId: "oversized-jsonl" })
    await expect(
      collect(oversized.send({ sessionId: "oversized-jsonl", message: "hello" })),
    ).rejects.toMatchObject({ code: "PI_PROTOCOL" })
    await oversized.close("oversized-jsonl")
  })

  test("cancelling an idle session does not fabricate a stopped turn", async () => {
    const backend = new PiBackend({
      command: process.execPath,
      rpcArgs: ["-e", "setInterval(() => {}, 1000)"],
    })
    await backend.createSession({ cwd: process.cwd(), sessionId: "idle-cancel" })
    await backend.cancel("idle-cancel")
    expect((await backend.snapshot("idle-cancel")).status).toBe("idle")
    await backend.close("idle-cancel")
  })

  test("maps a successful Pi reload response", async () => {
    const fakeReload = `
process.stdin.on("data", (chunk) => {
  const command = JSON.parse(String(chunk))
  if (command.type === "reload") process.stdout.write(JSON.stringify({ type: "response", command: "reload", success: true, data: { revision: "r2", loaded: ["demo"], disabled: [], rolledBack: false } }) + "\\n")
})
`
    const backend = new PiBackend({
      command: process.execPath,
      rpcArgs: ["-e", fakeReload],
      reloadCommand: "rpc",
    })
    await backend.createSession({ cwd: process.cwd(), sessionId: "reload" })
    const result = await backend.reload("reload")
    expect(result).toEqual({ revision: "r2", loaded: ["demo"], disabled: [], rolledBack: false })
    expect((await backend.snapshot("reload")).extensionRevision).toBe("r2")
    await backend.close("reload")
  })

  test("an old request signal cannot stop a later prompt on the same session", async () => {
    const fakeTurns = `
let buffer = ""
function emit(value) { process.stdout.write(JSON.stringify(value) + "\\n") }
function finish() {
  emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } })
  emit({ type: "agent_end" })
}
process.stdin.on("data", (chunk) => {
  buffer += String(chunk)
  for (;;) {
    const newline = buffer.indexOf("\\n")
    if (newline === -1) break
    const command = JSON.parse(buffer.slice(0, newline))
    buffer = buffer.slice(newline + 1)
    if (command.type === "prompt" && command.message === "one") finish()
    if (command.type === "prompt" && command.message === "two") setTimeout(finish, 25)
    if (command.type === "abort") emit({ type: "agent_end" })
  }
})
`
    const backend = new PiBackend({ command: process.execPath, rpcArgs: ["-e", fakeTurns] })
    const firstSignal = new AbortController()
    await backend.createSession({ cwd: process.cwd(), sessionId: "stale-signal" })
    await collect(
      backend.send({ sessionId: "stale-signal", message: "one", signal: firstSignal.signal }),
    )

    const second = collect(backend.send({ sessionId: "stale-signal", message: "two" }))
    firstSignal.abort("old request ended")
    const events = await second
    expect(events.some((event) => event.type === "session.stopped")).toBe(false)
    expect(events.some((event) => event.type === "session.completed")).toBe(true)
    expect((await backend.snapshot("stale-signal")).status).toBe("idle")
    await backend.close("stale-signal")
  })

  test("close racing a process reload never resurrects the session", async () => {
    const fakeRestart = `
process.stdin.on("data", () => {})
setInterval(() => {}, 1000)
`
    const backend = new PiBackend({ command: process.execPath, rpcArgs: ["-e", fakeRestart] })
    await backend.createSession({ cwd: process.cwd(), sessionId: "reload-race" })
    const reloading = backend.reload("reload-race")
    await backend.close("reload-race")
    await expect(reloading).resolves.toMatchObject({ error: { code: "SESSION_CLOSED" } })
    await expect(backend.snapshot("reload-race")).rejects.toThrow(/unknown session/)
  })

  test("preserves the Pi session while reloading by default", async () => {
    const fakeRestart = `
process.stdin.on("data", () => {})
setInterval(() => {}, 1000)
`
    const backend = new PiBackend({ command: process.execPath, rpcArgs: ["-e", fakeRestart] })
    const before = await backend.createSession({ cwd: process.cwd(), sessionId: "restart-reload" })
    await expect(backend.reload("restart-reload")).resolves.toMatchObject({
      revision: "pi:1",
      loaded: [],
      disabled: [],
      rolledBack: false,
    })
    expect((await backend.snapshot("restart-reload")).id).toBe(before.id)
    await backend.close("restart-reload")
  })

  test("maps Pi RPC confirmation requests and resolves them", async () => {
    const fakeApproval = `
let buffer = ""
process.stdin.on("data", (chunk) => {
  buffer += String(chunk)
  for (;;) {
    const newline = buffer.indexOf("\\n")
    if (newline === -1) break
    const command = JSON.parse(buffer.slice(0, newline))
    buffer = buffer.slice(newline + 1)
    if (command.type === "prompt") process.stdout.write(JSON.stringify({ type: "extension_ui_request", id: "confirm-1", method: "confirm", title: "Allow write", message: "write file" }) + "\\n")
    if (command.type === "extension_ui_response") process.stdout.write(JSON.stringify({ type: "agent_end" }) + "\\n")
  }
})
`
    const backend = new PiBackend({ command: process.execPath, rpcArgs: ["-e", fakeApproval] })
    await backend.createSession({ cwd: process.cwd(), sessionId: "approval" })
    const events = []
    for await (const event of backend.send({ sessionId: "approval", message: "hello" })) {
      events.push(event)
      if (event.type === "approval.required")
        await backend.resolveApproval("approval", event.approvalId, true)
    }
    expect(events.some((event) => event.type === "approval.required")).toBe(true)
    await backend.close("approval")
  })

  test("ships an opt-in Nifra verification extension through Pi's public API", async () => {
    type Tool = {
      execute: (
        toolCallId: string,
        input: unknown,
        signal: AbortSignal,
      ) => Promise<{ content: readonly { text: string }[] }>
    }
    const tools = new Map<string, Tool>()
    const fakePi = {
      registerTool(tool: { name: string; execute: Tool["execute"] }) {
        tools.set(tool.name, tool)
      },
      exec: async (command: string, args: readonly string[]) => ({
        stdout: JSON.stringify({ command, args }),
        code: 0,
      }),
    }
    registerNifraTools(fakePi)
    expect([...tools.keys()]).toEqual([
      "nifra_context",
      "nifra_check",
      "nifra_assure",
      "nifra_test",
    ])
    expect(
      (await tools.get("nifra_check")!.execute("call", {}, new AbortController().signal)).content[0]
        ?.text,
    ).toContain("--json")
    // There is no `nifra test`: the test gate is the project's own suite.
    expect(
      JSON.parse(
        (await tools.get("nifra_test")!.execute("call", {}, new AbortController().signal))
          .content[0]?.text ?? "",
      ),
    ).toEqual({ command: "bun", args: ["test"] })
  })
})
