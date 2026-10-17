import { describe, expect, test } from "bun:test"
import type { AgentEvent } from "@nifrajs/agent-protocol"
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

describe("PiBackend", () => {
  async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
    const values: T[] = []
    for await (const value of source) values.push(value)
    return values
  }

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

  test("the record cap applies to each JSONL record, not to a chunk holding several", async () => {
    const fakeBatched = `
process.stdin.on("data", (chunk) => {
  if (!String(chunk).includes("prompt")) return
  const delta = (text) => JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } })
  process.stdout.write([delta("x".repeat(700)), delta("y".repeat(700)), JSON.stringify({ type: "agent_end" }), JSON.stringify({ type: "agent_settled" })].join("\\n") + "\\n")
})
`
    const backend = new PiBackend({
      command: process.execPath,
      rpcArgs: ["-e", fakeBatched],
      maxRecordBytes: 1_024,
    })
    await backend.createSession({ cwd: process.cwd(), sessionId: "batched-jsonl" })
    const events = await collect(backend.send({ sessionId: "batched-jsonl", message: "hello" }))
    await backend.close("batched-jsonl")
    expect(events.filter((event) => event.type === "assistant.delta")).toHaveLength(2)
    expect(events.some((event) => event.type === "session.failed")).toBe(false)
  })

  test("a turn whose provider login was refused fails with PI_AUTH_REQUIRED instead of completing", async () => {
    const script = `
process.stdin.on("data", (chunk) => {
  if (!String(chunk).includes("prompt")) return
  const failed = { role: "assistant", content: [], stopReason: "error", errorMessage: "OAuth refresh failed for openai-codex" }
  process.stdout.write(JSON.stringify({ type: "message_end", message: failed }) + "\\n")
  process.stdout.write(JSON.stringify({ type: "agent_end", messages: [failed], willRetry: false }) + "\\n")
  process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n")
})
`
    const backend = new PiBackend({ command: process.execPath, rpcArgs: ["-e", script] })
    try {
      await backend.createSession({ cwd: process.cwd(), sessionId: "model-failed" })
      const events: AgentEvent[] = []
      await expect(
        (async () => {
          for await (const event of backend.send({ sessionId: "model-failed", message: "hello" }))
            events.push(event)
        })(),
      ).rejects.toMatchObject({ code: "PI_AUTH_REQUIRED" })
      expect(events.some((event) => event.type === "session.completed")).toBe(false)
      expect(events.find((event) => event.type === "session.failed")).toMatchObject({
        error: { code: "PI_AUTH_REQUIRED", message: "OAuth refresh failed for openai-codex" },
      })
      expect((await backend.snapshot("model-failed")).status).toBe("failed")
    } finally {
      await backend.close("model-failed")
    }
  })

  test("a model failure other than a refused credential is PI_MODEL_FAILED", async () => {
    const script = `
process.stdin.on("data", (chunk) => {
  if (!String(chunk).includes("prompt")) return
  const failed = { role: "assistant", content: [], stopReason: "error", errorMessage: "503 Service Unavailable: the model is overloaded" }
  process.stdout.write(JSON.stringify({ type: "message_end", message: failed }) + "\\n")
  process.stdout.write(JSON.stringify({ type: "agent_end", messages: [failed], willRetry: false }) + "\\n")
  process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n")
})
`
    const backend = new PiBackend({ command: process.execPath, rpcArgs: ["-e", script] })
    try {
      await backend.createSession({ cwd: process.cwd(), sessionId: "model-overloaded" })
      const events: AgentEvent[] = []
      await expect(
        (async () => {
          for await (const event of backend.send({
            sessionId: "model-overloaded",
            message: "hello",
          }))
            events.push(event)
        })(),
      ).rejects.toMatchObject({ code: "PI_MODEL_FAILED" })
      expect(events.some((event) => event.type === "session.completed")).toBe(false)
      expect(events.find((event) => event.type === "session.failed")).toMatchObject({
        error: {
          code: "PI_MODEL_FAILED",
          message: "503 Service Unavailable: the model is overloaded",
        },
      })
      expect((await backend.snapshot("model-overloaded")).status).toBe("failed")
    } finally {
      await backend.close("model-overloaded")
    }
  })

  test("a model error keeps its reason and not a credential the provider echoed", async () => {
    const script = `
process.stdin.on("data", (chunk) => {
  if (!String(chunk).includes("prompt")) return
  const failed = { role: "assistant", content: [], stopReason: "error", errorMessage: "401 Incorrect API key provided: sk-proj-abcdefghijklmnop1234. Authorization: Bearer eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl" }
  process.stdout.write(JSON.stringify({ type: "message_end", message: failed }) + "\\n")
  process.stdout.write(JSON.stringify({ type: "agent_end", messages: [failed] }) + "\\n")
})
`
    const backend = new PiBackend({ command: process.execPath, rpcArgs: ["-e", script] })
    try {
      await backend.createSession({ cwd: process.cwd(), sessionId: "model-key-echo" })
      const events: AgentEvent[] = []
      await expect(
        (async () => {
          for await (const event of backend.send({ sessionId: "model-key-echo", message: "hello" }))
            events.push(event)
        })(),
      ).rejects.toMatchObject({ code: "PI_AUTH_REQUIRED" })
      const failed = events.find((event) => event.type === "session.failed")
      const message = failed?.type === "session.failed" ? failed.error.message : ""
      expect(message).toContain("401 Incorrect API key provided: [REDACTED]")
      expect(message).not.toContain("abcdefghijklmnop")
      expect(message).not.toContain("eyJ")
    } finally {
      await backend.close("model-key-echo")
    }
  })

  test("a diagnostic masks every credential Pi was given, whatever its shape", async () => {
    const groq = "gsk_SYNTHETICabcdefghijklmnopqrstuvwxyz0123"
    const opaque = "opaque-proxy-credential-0123"
    const script = `
process.stdin.on("data", (chunk) => {
  if (!String(chunk).includes("prompt")) return
  const echoed = "401 Unauthorized: invalid api key " + process.env.GROQ_API_KEY + " via " + process.env.PROXY_TOKEN
  process.stdout.write(JSON.stringify({ type: "extension_error", error: echoed }) + "\\n")
  const failed = { role: "assistant", content: [], stopReason: "error", errorMessage: echoed }
  process.stdout.write(JSON.stringify({ type: "message_end", message: failed }) + "\\n")
  process.stdout.write(JSON.stringify({ type: "agent_end", messages: [failed] }) + "\\n")
})
`
    const backend = new PiBackend({
      command: process.execPath,
      rpcArgs: ["-e", script],
      env: { GROQ_API_KEY: groq, PROXY_TOKEN: opaque },
    })
    try {
      await backend.createSession({ cwd: process.cwd(), sessionId: "value-echo" })
      const events: AgentEvent[] = []
      let rejection: unknown
      try {
        for await (const event of backend.send({ sessionId: "value-echo", message: "hello" }))
          events.push(event)
      } catch (error) {
        rejection = error
      }
      expect(rejection).toMatchObject({ code: "PI_AUTH_REQUIRED" })
      const failures = events.filter((event) => event.type === "session.failed")
      expect(failures.length).toBe(2)
      for (const text of [JSON.stringify(rejection), JSON.stringify(failures)]) {
        expect(text).toContain("invalid api key [REDACTED] via [REDACTED]")
        expect(text).not.toContain("SYNTHETIC")
        expect(text).not.toContain(opaque)
      }
    } finally {
      await backend.close("value-echo")
    }
  })

  test("a model error Pi retries does not end the turn, and the retried answer completes it", async () => {
    const script = `
process.stdin.on("data", (chunk) => {
  if (!String(chunk).includes("prompt")) return
  const failed = { role: "assistant", content: [], stopReason: "error", errorMessage: "overloaded" }
  const answered = { role: "assistant", content: [{ type: "text", text: "retried" }], stopReason: "stop" }
  process.stdout.write(JSON.stringify({ type: "message_end", message: failed }) + "\\n")
  process.stdout.write(JSON.stringify({ type: "agent_end", messages: [failed], willRetry: true }) + "\\n")
  process.stdout.write(JSON.stringify({ type: "auto_retry_start", attempt: 1 }) + "\\n")
  process.stdout.write(JSON.stringify({ type: "message_end", message: answered }) + "\\n")
  process.stdout.write(JSON.stringify({ type: "agent_end", messages: [answered], willRetry: false }) + "\\n")
})
`
    const backend = new PiBackend({ command: process.execPath, rpcArgs: ["-e", script] })
    try {
      await backend.createSession({ cwd: process.cwd(), sessionId: "model-retried" })
      const events = await collect(backend.send({ sessionId: "model-retried", message: "hello" }))
      expect(events.find((event) => event.type === "assistant.message")).toMatchObject({
        text: "retried",
      })
      expect(events.at(-1)?.type).toBe("session.completed")
      expect(events.some((event) => event.type === "session.failed")).toBe(false)
    } finally {
      await backend.close("model-retried")
    }
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

  test("records a cancelled run sends late never reach the next turn", async () => {
    // Pi ends an aborted run on its own schedule; here its leftovers land after the next send.
    // "answer" ends the aborted run with an abort response, "late" ends it after the next prompt ran.
    const lateRecords = (mode: "end" | "answer" | "late") => `
let buffer = ""
function emit(value) { process.stdout.write(JSON.stringify(value) + "\\n") }
function finish(text) {
  emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } })
  emit({ type: "agent_end" })
}
process.stdin.on("data", (chunk) => {
  buffer += String(chunk)
  for (;;) {
    const newline = buffer.indexOf("\\n")
    if (newline === -1) break
    const command = JSON.parse(buffer.slice(0, newline))
    buffer = buffer.slice(newline + 1)
    if (command.type === "prompt" && command.message === "new") finish("new")
    if (command.type === "abort" && "${mode}" === "answer") {
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "old" } })
      emit({ type: "response", command: "abort", success: true })
    } else if (command.type === "abort" && "${mode}" === "late") setTimeout(() => finish("old"), 50)
    else if (command.type === "abort") finish("old")
  }
})
`
    for (const mode of ["end", "answer", "late"] as const) {
      const backend = new PiBackend({
        command: process.execPath,
        rpcArgs: ["-e", lateRecords(mode)],
      })
      await backend.createSession({ cwd: process.cwd(), sessionId: "late-records" })
      const first = collect(backend.send({ sessionId: "late-records", message: "old" }))
      const cancelling = backend.cancel("late-records")
      const second = collect(backend.send({ sessionId: "late-records", message: "new" }))
      await Promise.all([first, cancelling])
      const texts = (await second).flatMap((event) =>
        event.type === "assistant.message" || event.type === "assistant.delta" ? [event.text] : [],
      )
      expect(texts).toEqual(["new"])
      await backend.close("late-records")
    }
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

  test("cancels an extension dialog it cannot map instead of leaving the turn waiting", async () => {
    const fakeDialog = `
let buffer = ""
process.stdin.on("data", (chunk) => {
  buffer += String(chunk)
  for (;;) {
    const newline = buffer.indexOf("\\n")
    if (newline === -1) break
    const command = JSON.parse(buffer.slice(0, newline))
    buffer = buffer.slice(newline + 1)
    if (command.type === "prompt") {
      process.stdout.write(JSON.stringify({ type: "extension_ui_request", id: "note-1", method: "notify", message: "hi" }) + "\\n")
      process.stdout.write(JSON.stringify({ type: "extension_ui_request", id: "select-1", method: "select", title: "Pick", options: ["a", "b"] }) + "\\n")
    }
    if (command.type === "extension_ui_response") {
      process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: JSON.stringify(command) } }) + "\\n")
      process.stdout.write(JSON.stringify({ type: "agent_end" }) + "\\n")
    }
  }
})
`
    const backend = new PiBackend({ command: process.execPath, rpcArgs: ["-e", fakeDialog] })
    await backend.createSession({ cwd: process.cwd(), sessionId: "dialog" })
    const replies: string[] = []
    for await (const event of backend.send({ sessionId: "dialog", message: "hello" }))
      if (event.type === "assistant.message") replies.push(event.text)
    expect(replies).toEqual([
      JSON.stringify({ type: "extension_ui_response", id: "select-1", cancelled: true }),
    ])
    await backend.close("dialog")
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
