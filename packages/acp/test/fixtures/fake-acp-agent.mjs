// A scripted ACP agent: flags shape the handshake, the prompt text picks the turn.
import { spawn } from "node:child_process"

const flags = new Set(process.argv.slice(2))
const SESSION = "acp-session-1"
const waiting = new Map()
let authed = false
let buffer = ""
let nextId = 1000
let promptId
let onCancel

const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
const update = (value) =>
  send({ method: "session/update", params: { sessionId: SESSION, update: value } })
const say = (text) =>
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } })
const finish = (stopReason) => send({ id: promptId, result: { stopReason } })
const ask = (method, params) => {
  const id = nextId++
  send({ id, method, params })
  return new Promise((resolve) => waiting.set(id, resolve))
}
const permission = (toolCallId) =>
  ask("session/request_permission", {
    sessionId: SESSION,
    toolCall: { toolCallId, title: "Write a.txt", kind: "edit" },
    options: [
      { optionId: "always", name: "Always allow", kind: "allow_always" },
      { optionId: "yes", name: "Allow", kind: "allow_once" },
      { optionId: "no", name: "Reject", kind: "reject_once" },
    ],
  })

process.stdin.on("data", (chunk) => {
  buffer += String(chunk)
  for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (line.trim().length > 0) void handle(JSON.parse(line))
  }
})

async function handle(message) {
  if (message.method === undefined) {
    waiting.get(message.id)?.(message)
    waiting.delete(message.id)
    return
  }
  switch (message.method) {
    case "initialize":
      if (flags.has("--die-on-init-late-stderr")) {
        // A child keeps stderr open and writes the reason only once this process is gone.
        const script = `const gone = () => { try { process.kill(${process.pid}, 0); return false } catch { return true } };
const wait = setInterval(() => { if (gone()) { clearInterval(wait); process.stderr.write("fatal: no credentials\\n") } }, 2)`
        spawn(process.execPath, ["-e", script], { stdio: ["ignore", "ignore", "inherit"] }).unref()
        process.exit(2)
      }
      if (flags.has("--die-on-init")) {
        process.stderr.write("\u001b[31mfatal: no credentials for sk-abcdefghijklmnop\u001b[0m\n")
        process.exit(2)
      }
      send({
        id: message.id,
        result: {
          protocolVersion: flags.has("--v2") ? 2 : 1,
          agentCapabilities: {},
          authMethods: [{ id: "token", name: "Token" }],
        },
      })
      return
    case "authenticate":
      authed = message.params.methodId === "token"
      send({ id: message.id, result: {} })
      return
    case "session/new":
      if (flags.has("--need-auth") && !authed)
        send({ id: message.id, error: { code: -32000, message: "Authentication required" } })
      else send({ id: message.id, result: flags.has("--no-session") ? {} : { sessionId: SESSION } })
      return
    case "session/cancel":
      onCancel?.()
      return
    case "session/prompt":
      promptId = message.id
      await prompt(message.params.prompt[0].text)
      return
  }
}

async function prompt(text) {
  switch (text) {
    case "slow":
      onCancel = () => finish("cancelled")
      return
    case "stubborn":
      onCancel = () => {}
      return
    case "approve": {
      onCancel = () => {}
      say("Writing.")
      update({
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        title: "Write a.txt",
        kind: "edit",
        status: "pending",
        rawInput: { path: "a.txt" },
      })
      const outcome = (await permission("call_1")).result.outcome
      if (outcome.outcome === "cancelled") {
        finish("cancelled")
        return
      }
      if (outcome.optionId === "yes") {
        update({
          sessionUpdate: "tool_call_update",
          toolCallId: "call_1",
          status: "completed",
          rawOutput: "written",
        })
        say("Done.")
      } else update({ sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "failed" })
      finish("end_turn")
      return
    }
    case "withdraw": {
      const answer = permission("call_2")
      send({ method: "$/cancel_request", params: { requestId: nextId - 1 } })
      say(`withdrawn:${(await answer).error.code}`)
      finish("end_turn")
      return
    }
    case "client-methods": {
      const read = await ask("fs/read_text_file", { sessionId: SESSION, path: "/etc/hosts" })
      const bad = await ask("session/request_permission", [])
      say(`${read.error.code},${bad.error.code}`)
      finish("end_turn")
      return
    }
    case "env":
      say(
        [process.env.VISIBLE, process.env.HOME, process.env.NIFRA_ACP_LEAK]
          .map((value) => value ?? "none")
          .join("|"),
      )
      finish("end_turn")
      return
    case "refuse":
      finish("refusal")
      return
    case "max":
      say("partial")
      finish("max_tokens")
      return
    case "no-stop":
      send({ id: promptId, result: {} })
      return
    case "fail":
      send({
        id: promptId,
        error: {
          code: -32603,
          message: `model exploded with ${process.env.MY_TOKEN} and sk-abcdefghijk12345`,
        },
      })
      return
    case "crash":
      process.stderr.write(`starting\nError: boom ${process.env.MY_TOKEN}\nbye`)
      setTimeout(() => process.exit(3), 10)
      return
    case "garbage":
      process.stdout.write("this is not json\n")
      return
    case "oversized":
      process.stdout.write(`${"x".repeat(4096)}\n`)
      return
    case "bad-update":
      update({ sessionUpdate: "tool_call", toolCallId: "call_3", kind: "x".repeat(200) })
      say("ok")
      update({ sessionUpdate: "plan", entries: "nope" })
      update({ sessionUpdate: "usage_update", used: -1 })
      update({ sessionUpdate: "agent_thought_chunk", content: { type: "image" } })
      update({ sessionUpdate: "Not A Token!" })
      send({
        method: "session/update",
        params: { sessionId: "another", update: { sessionUpdate: "plan", entries: [] } },
      })
      send({ method: "unknown/notification", params: {} })
      send({ id: "999", result: {} })
      finish("end_turn")
      return
    default:
      say("hel")
      say("lo")
      update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } })
      update({
        sessionUpdate: "plan",
        entries: [
          { content: "Read", status: "completed", priority: "high" },
          { content: "Write", status: "in_progress" },
          { content: "Skip", status: "unknown" },
        ],
      })
      update({ sessionUpdate: "usage_update", used: 1200, size: 200000 })
      update({ sessionUpdate: "usage_update", used: 1300 })
      update({ sessionUpdate: "available_commands_update", availableCommands: [] })
      finish("end_turn")
  }
}
