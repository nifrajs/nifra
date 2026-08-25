import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentBackend } from "@nifrajs/agent-protocol"
import { PiBackend } from "@nifrajs/pi"
import { ExtensionHost } from "../src/extensions.ts"
import { CodingAgentRpcServer } from "../src/rpc.ts"
import { FileSessionStore } from "../src/sessions.ts"

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
      process.stdout.write(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "rpc-ok" } }) + "\\n")
      process.stdout.write(JSON.stringify({ type: "agent_end" }) + "\\n")
    }
  }
})
`

function failingBackend(message: string): AgentBackend {
  const fail = async (): Promise<never> => {
    throw new Error(message)
  }
  return {
    info: { name: "failing", capabilities: [] },
    createSession: fail,
    send: () => {
      throw new Error(message)
    },
    cancel: fail,
    snapshot: fail,
    reload: fail,
    close: fail,
  }
}

describe("coding agent RPC", () => {
  test("rejects remote binding unless explicitly enabled", () => {
    expect(
      new CodingAgentRpcServer({
        hostname: "0.0.0.0",
        cwd: process.cwd(),
        backend: new PiBackend({ command: process.execPath, rpcArgs: ["-e", fakePi] }),
      }).start(),
    ).rejects.toThrow("remote binding")
  })

  test("rejects error-stack diagnostics for remote binding", () => {
    expect(
      new CodingAgentRpcServer({
        hostname: "0.0.0.0",
        allowRemote: true,
        exposeErrorStacks: true,
        cwd: process.cwd(),
        backend: new PiBackend({ command: process.execPath, rpcArgs: ["-e", fakePi] }),
      }).start(),
    ).rejects.toThrow("exposeErrorStacks")
  })

  test("returns actionable errors and opts into stacks only on loopback", async () => {
    for (const exposeErrorStacks of [false, true]) {
      const rpc = new CodingAgentRpcServer({
        cwd: process.cwd(),
        backend: failingBackend("backend session initialization failed"),
        exposeErrorStacks,
      })
      const handle = await rpc.start()
      try {
        const response = await fetch(`${handle.url}/rpc`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${handle.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ method: "session.create" }),
        })
        const body = (await response.json()) as {
          error: { message: string; stack?: string }
        }
        expect(response.status).toBe(500)
        expect(body.error.message).toBe("backend session initialization failed")
        if (exposeErrorStacks)
          expect(body.error.stack).toContain("backend session initialization failed")
        else expect(body.error.stack).toBeUndefined()
      } finally {
        await rpc.stop()
      }
    }
  })

  test("requires a token and streams a turn over SSE", async () => {
    const root = await mkdtemp(join(tmpdir(), "nifra-agent-rpc-"))
    const rpc = new CodingAgentRpcServer({
      cwd: process.cwd(),
      backend: new PiBackend({ command: process.execPath, rpcArgs: ["-e", fakePi] }),
      sessionStore: new FileSessionStore({ root }),
    })
    const handle = await rpc.start()
    try {
      expect((await fetch(`${handle.url}/health`)).status).toBe(200)
      expect(
        (
          await fetch(`${handle.url}/rpc`, {
            method: "POST",
            body: JSON.stringify({ method: "session.create" }),
          })
        ).status,
      ).toBe(401)
      const headers = {
        authorization: `Bearer ${handle.token}`,
        "content-type": "application/json",
      }
      expect(
        (await fetch(`${handle.url}/rpc`, { method: "POST", headers, body: "not-json" })).status,
      ).toBe(400)
      const session = await fetch(`${handle.url}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({ method: "session.create" }),
      })
      expect(session.status).toBe(200)
      expect(
        (
          await fetch(`${handle.url}/rpc`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              method: "session.checkpoint",
              params: { payload: { risk: "low" } },
            }),
          })
        ).status,
      ).toBe(200)
      const history = await fetch(`${handle.url}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({ method: "session.events", params: { limit: 10 } }),
      })
      const historyEntries = (
        (await history.json()) as { entries: Array<{ type: string; seq: number }> }
      ).entries
      expect(historyEntries.length).toBeGreaterThan(0)
      expect(historyEntries.some((entry) => entry.type === "session.checkpoint")).toBe(true)
      // A cursor opts into the bounded snapshot + resume view. -1 replays the whole window.
      const resumeAll = await fetch(`${handle.url}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({ method: "session.events", params: { limit: 10, cursor: -1 } }),
      })
      const resumeAllBody = (await resumeAll.json()) as {
        snapshot: { id: string; lastSeq: number }
        resume: { status: string; events: Array<{ seq: number }>; nextCursor: number }
      }
      const tailSeq = Math.max(...historyEntries.map((entry) => entry.seq))
      expect(resumeAllBody.snapshot.id.length).toBeGreaterThan(0)
      expect(resumeAllBody.resume.status).toBe("ok")
      expect(resumeAllBody.resume.events.length).toBe(historyEntries.length)
      expect(resumeAllBody.resume.nextCursor).toBe(tailSeq)
      // Resuming past the last delivered seq yields nothing new and holds the cursor.
      const resumeTip = await fetch(`${handle.url}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          method: "session.events",
          params: { limit: 10, cursor: resumeAllBody.resume.nextCursor },
        }),
      })
      const resumeTipBody = (await resumeTip.json()) as {
        resume: { status: string; events: unknown[]; nextCursor: number }
      }
      expect(resumeTipBody.resume.status).toBe("ok")
      expect(resumeTipBody.resume.events.length).toBe(0)
      expect(resumeTipBody.resume.nextCursor).toBe(resumeAllBody.resume.nextCursor)
      // Grow the log so a limit-1 window's earliest seq sits well past an old cursor.
      for (let i = 0; i < 3; i++)
        await fetch(`${handle.url}/rpc`, {
          method: "POST",
          headers,
          body: JSON.stringify({ method: "session.checkpoint", params: { payload: { i } } }),
        })
      // A bounded window (limit 1) that no longer contains the record after the cursor forces resync.
      const stale = await fetch(`${handle.url}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({ method: "session.events", params: { limit: 1, cursor: 0 } }),
      })
      const staleBody = (await stale.json()) as { resume: { status: string; reason?: string } }
      expect(staleBody.resume.status).toBe("resync_required")
      expect(staleBody.resume.reason).toBe("stale_cursor")
      // An out-of-range cursor is rejected.
      const badCursor = await fetch(`${handle.url}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({ method: "session.events", params: { cursor: -2 } }),
      })
      expect(badCursor.status).toBe(422)
      const diff = await fetch(`${handle.url}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({ method: "project.diff" }),
      })
      expect(diff.status).toBe(200)
      expect(((await diff.json()) as { ok: boolean; status: number | null }).ok).toBe(true)
      const fork = await fetch(`${handle.url}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({ method: "session.fork", params: { targetSessionId: "branch" } }),
      })
      expect(fork.status).toBe(201)
      const approval = await fetch(`${handle.url}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          method: "approval.request",
          params: { action: "write file", capability: "filesystem" },
        }),
      })
      expect(approval.status).toBe(201)
      const approvalPayload = (await approval.json()) as { id: string }
      const pending = await fetch(`${handle.url}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({ method: "approval.list" }),
      })
      expect(((await pending.json()) as { pending: unknown[] }).pending).toHaveLength(1)
      const resolved = await fetch(`${handle.url}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          method: "approval.resolve",
          params: { approvalId: approvalPayload.id, approved: true },
        }),
      })
      expect(((await resolved.json()) as { approved: boolean }).approved).toBe(true)
      const turn = await fetch(`${handle.url}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({ method: "turn.send", params: { message: "hello" } }),
      })
      expect(turn.status).toBe(200)
      expect(await turn.text()).toContain("rpc-ok")
    } finally {
      await rpc.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  test("resumes a persisted session through the RPC seam", async () => {
    const root = await mkdtemp(join(tmpdir(), "nifra-agent-resume-"))
    const store = new FileSessionStore({ root })
    const first = new CodingAgentRpcServer({
      cwd: process.cwd(),
      backend: new PiBackend({ command: process.execPath, rpcArgs: ["-e", fakePi] }),
      sessionStore: store,
    })
    const firstHandle = await first.start()
    const headers = {
      authorization: `Bearer ${firstHandle.token}`,
      "content-type": "application/json",
    }
    try {
      const created = await fetch(`${firstHandle.url}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({ method: "session.create", params: { sessionId: "resume-me" } }),
      })
      expect(created.status).toBe(200)
    } finally {
      await first.stop()
    }
    const second = new CodingAgentRpcServer({
      cwd: process.cwd(),
      backend: new PiBackend({ command: process.execPath, rpcArgs: ["-e", fakePi] }),
      sessionStore: new FileSessionStore({ root }),
    })
    const secondHandle = await second.start()
    try {
      const secondHeaders = {
        authorization: `Bearer ${secondHandle.token}`,
        "content-type": "application/json",
      }
      const resumed = await fetch(`${secondHandle.url}/rpc`, {
        method: "POST",
        headers: secondHeaders,
        body: JSON.stringify({ method: "session.resume", params: { sessionId: "resume-me" } }),
      })
      expect(resumed.status).toBe(200)
      expect(((await resumed.json()) as { id: string }).id).toBe("resume-me")
    } finally {
      await second.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  test("lists and runs workflow extensions over authenticated RPC", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nifra-agent-workflow-rpc-"))
    await writeFile(
      join(cwd, "workflow.ts"),
      `export default ({ registerWorkflow }) => registerWorkflow("smoke", () => ({ type: "task", id: "smoke", run: () => "ok" }))`,
    )
    const rpc = new CodingAgentRpcServer({
      cwd,
      backend: new PiBackend({ command: process.execPath, rpcArgs: ["-e", fakePi] }),
      extensions: new ExtensionHost({ cwd, roots: ["workflow.ts"] }),
    })
    const handle = await rpc.start()
    const headers = {
      authorization: `Bearer ${handle.token}`,
      "content-type": "application/json",
    }
    try {
      const create = await fetch(`${handle.url}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({ method: "session.create" }),
      })
      expect(create.status).toBe(200)
      const list = await fetch(`${handle.url}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({ method: "workflow.list" }),
      })
      expect(((await list.json()) as { workflows: string[] }).workflows).toEqual(["smoke"])
      const run = await fetch(`${handle.url}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({ method: "workflow.run", params: { name: "smoke" } }),
      })
      expect(run.status).toBe(200)
      expect(((await run.json()) as { ok: boolean }).ok).toBe(true)
    } finally {
      await rpc.stop()
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
