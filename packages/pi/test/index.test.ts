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
      exec: async (_command: string, args: readonly string[]) => ({
        stdout: JSON.stringify({ args }),
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
  })
})
