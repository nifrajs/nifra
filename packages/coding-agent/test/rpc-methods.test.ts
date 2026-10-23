import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentEvent } from "@nifrajs/agent-protocol"
import { ExtensionHost } from "../src/extensions.ts"
import { NifraBackend } from "../src/native.ts"
import { CodingAgentRpcServer, type CodingAgentRpcServerOptions } from "../src/rpc.ts"
import { UiExtensionHost } from "../src/ui.ts"

type Call = (method: string, params?: unknown) => Promise<Response>

const textBackend = () =>
  new NifraBackend({ model: { complete: () => ({ type: "text", text: "ok" }) } })

async function withRpc(
  options: Partial<CodingAgentRpcServerOptions>,
  run: (call: Call, handle: { readonly url: string; readonly token: string }) => Promise<void>,
): Promise<void> {
  const rpc = new CodingAgentRpcServer({ cwd: process.cwd(), backend: textBackend(), ...options })
  const handle = await rpc.start()
  const call: Call = (method, params) =>
    fetch(`${handle.url}/rpc`, {
      method: "POST",
      headers: { authorization: `Bearer ${handle.token}`, "content-type": "application/json" },
      body: JSON.stringify(params === undefined ? { method } : { method, params }),
    })
  try {
    await run(call, handle)
  } finally {
    await rpc.stop()
  }
}

async function errorOf(response: Response): Promise<{ status: number; code: string }> {
  const body: { error: { code: string } } = await response.json()
  return { status: response.status, code: body.error.code }
}

function sseEvents(text: string): AgentEvent[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)))
}

describe("coding agent RPC options", () => {
  const base = () => ({ cwd: process.cwd(), backend: textBackend() })

  test("the constructor refuses a malformed token and out-of-range limits", () => {
    expect(() => new CodingAgentRpcServer({ ...base(), authToken: "short" })).toThrow(
      "authToken must be a bounded token",
    )
    expect(() => new CodingAgentRpcServer({ ...base(), maxBodyBytes: 512 })).toThrow(
      "maxBodyBytes must be between 1024",
    )
    expect(() => new CodingAgentRpcServer({ ...base(), maxResponseBytes: 512 })).toThrow(
      "maxResponseBytes must be between 1024",
    )
    expect(
      () => new CodingAgentRpcServer({ ...base(), resumableTurns: { replayEvents: 0 } }),
    ).toThrow("replayEvents must be between 1")
    expect(
      () => new CodingAgentRpcServer({ ...base(), resumableTurns: { replayBytes: 512 } }),
    ).toThrow("replayBytes must be between 1024")
    expect(
      () => new CodingAgentRpcServer({ ...base(), resumableTurns: { detachedTimeoutMs: 0 } }),
    ).toThrow("detachedTimeoutMs must be between 1")
  })

  test("the repair and extension-event options reach the host", () => {
    expect(() => new CodingAgentRpcServer({ ...base(), maxRepairAttempts: 9 })).toThrow(
      "maxRepairAttempts must be between 0 and 8",
    )
    expect(
      () => new CodingAgentRpcServer({ ...base(), extensionEvents: { plain: () => true } }),
    ).toThrow("extension event type must be x-<vendor>.<name>")
  })

  test("verifyAfterTurn runs the configured gate once a turn ends", () =>
    withRpc(
      {
        verifyAfterTurn: ["test"],
        maxRepairAttempts: 0,
        verification: { command: process.execPath, commandArgs: ["-e", "process.exit(0)"] },
      },
      async (call) => {
        expect((await call("session.create")).status).toBe(200)
        const turn = await call("turn.send", { message: "hello" })
        expect(turn.status).toBe(200)
        const verified = sseEvents(await turn.text()).find(
          (event) => event.type === "verification.completed",
        )
        expect(verified).toMatchObject({ name: "test", ok: true })
      },
    ))
})

describe("coding agent RPC transport", () => {
  test("refuses unknown endpoints, oversized bodies and malformed methods", () =>
    withRpc({ maxBodyBytes: 1024 }, async (call, handle) => {
      const authorization = `Bearer ${handle.token}`
      expect(
        await errorOf(await fetch(`${handle.url}/rpc`, { headers: { authorization } })),
      ).toEqual({ status: 404, code: "not_found" })
      const oversized = await fetch(`${handle.url}/rpc`, {
        method: "POST",
        headers: { authorization },
        body: "x".repeat(2048),
      })
      expect(oversized.status).toBe(413)
      expect(await oversized.json()).toEqual({
        error: { code: "invalid_request", message: "request body is too large" },
      })
      const malformed = await call("X")
      expect(malformed.status).toBe(400)
      expect(await malformed.json()).toMatchObject({
        error: { code: "invalid_request", message: "request method is invalid" },
      })
      const unknown = await call("session.nope")
      expect(unknown.status).toBe(404)
      expect(await unknown.json()).toEqual({
        error: { code: "method_not_found", message: "unknown method: session.nope" },
      })
    }))

  test("allows a loopback browser origin and no other", () =>
    withRpc({}, async (_call, handle) => {
      const origin = async (value: string) =>
        (await fetch(`${handle.url}/health`, { headers: { origin: value } })).headers.get(
          "access-control-allow-origin",
        )
      expect(await origin("http://localhost:5173")).toBe("http://localhost:5173")
      expect(await origin("http://127.0.0.1")).toBe("http://127.0.0.1")
      expect(await origin("https://example.com")).toBeNull()
    }))

  test("a turn error over the response limit falls back to a fixed frame", async () => {
    const backend = textBackend()
    backend.send = () => {
      throw new Error("x".repeat(2_000))
    }
    await withRpc({ backend, maxResponseBytes: 1024 }, async (call) => {
      expect((await call("session.create")).status).toBe(200)
      const turn = await call("turn.send", { message: "hello" })
      expect(await turn.text()).toBe(
        'event: error\ndata: {"code":"turn_failed","message":"turn could not be completed"}\n\n',
      )
    })
  })
})

describe("coding agent RPC session methods", () => {
  test("need a session, then validate their parameters", () =>
    withRpc({ resumableTurns: true }, async (call) => {
      expect(await errorOf(await call("session.snapshot"))).toEqual({
        status: 500,
        code: "rpc_failed",
      })
      expect(await errorOf(await call("session.resume", { sessionId: "not valid" }))).toEqual({
        status: 422,
        code: "invalid_session",
      })
      const created: { id: string } = await (await call("session.create")).json()
      const snapshot = await call("session.snapshot")
      expect(snapshot.status).toBe(200)
      expect(((await snapshot.json()) as { id: string }).id).toBe(created.id)
      expect(await errorOf(await call("session.events", { limit: 0 }))).toEqual({
        status: 422,
        code: "invalid_history_limit",
      })
      expect(await errorOf(await call("session.fork", { targetSessionId: 7 }))).toEqual({
        status: 422,
        code: "invalid_session",
      })
      expect(await errorOf(await call("turn.send", { message: "   " }))).toEqual({
        status: 422,
        code: "invalid_message",
      })
      expect(await errorOf(await call("turn.attach"))).toEqual({ status: 404, code: "no_turn" })
    }))

  test("reload, compact and stop the active session", () =>
    withRpc({}, async (call) => {
      expect((await call("session.create")).status).toBe(200)
      const reload = await call("session.reload")
      expect(reload.status).toBe(200)
      expect(await reload.json()).toMatchObject({ rolledBack: false, loaded: [], disabled: [] })
      const compact = await call("session.compact")
      expect(compact.status).toBe(200)
      expect(await compact.json()).toMatchObject({ reason: "manual", removed: 0 })
      const stop = await call("session.stop")
      expect(stop.status).toBe(200)
      expect(await stop.json()).toEqual({ ok: true })
      expect((await call("session.snapshot")).status).toBe(500)
    }))
})

describe("coding agent RPC approval methods", () => {
  test("validate their parameters and keep a caller's approval id", () =>
    withRpc({}, async (call) => {
      expect((await call("session.create")).status).toBe(200)
      expect(await errorOf(await call("approval.request", { action: 1 }))).toEqual({
        status: 422,
        code: "invalid_approval",
      })
      const offered = await call("approval.request", {
        approvalId: "chosen-id",
        action: "deploy",
        capability: "deploy",
      })
      expect(offered.status).toBe(201)
      expect(((await offered.json()) as { id: string }).id).toBe("chosen-id")
      expect(await errorOf(await call("approval.resolve", { approvalId: "chosen-id" }))).toEqual({
        status: 422,
        code: "invalid_approval",
      })
      const resolved = await call("approval.resolve", { approvalId: "chosen-id", approved: true })
      expect(resolved.status).toBe(200)
    }))
})

describe("coding agent RPC UI methods", () => {
  const manifest = { id: "status-bar", revision: "1", slot: "status", label: "Status" }

  test("report an empty graph and refuse changes without a UI host", () =>
    withRpc({}, async (call) => {
      expect((await call("session.create")).status).toBe(200)
      expect(await (await call("ui.snapshot")).json()).toEqual({ revision: "0", active: [] })
      for (const method of ["ui.reload", "ui.preview"])
        expect(await errorOf(await call(method, { manifests: [manifest] }))).toEqual({
          status: 409,
          code: "ui_unavailable",
        })
    }))

  test("preview a graph without applying it, then reload it", () =>
    withRpc({ ui: new UiExtensionHost() }, async (call) => {
      expect((await call("session.create")).status).toBe(200)
      for (const method of ["ui.reload", "ui.preview"])
        expect(await errorOf(await call(method, { manifests: "status-bar" }))).toEqual({
          status: 422,
          code: "invalid_ui",
        })
      const preview = await call("ui.preview", { manifests: [manifest] })
      expect(await preview.json()).toMatchObject({ revision: "preview:0", rolledBack: false })
      expect(await (await call("ui.snapshot")).json()).toEqual({ revision: "0", active: [] })
      const reload: { revision: string; rolledBack: boolean } = await (
        await call("ui.reload", { manifests: [manifest] })
      ).json()
      expect(reload.rolledBack).toBe(false)
      expect(await (await call("ui.snapshot")).json()).toEqual({
        revision: reload.revision,
        active: [{ ...manifest, capabilities: [] }],
      })
    }))
})

describe("coding agent RPC extension methods", () => {
  test("list nothing and refuse a workflow run without an extension host", () =>
    withRpc({}, async (call) => {
      expect((await call("session.create")).status).toBe(200)
      expect(await (await call("subagent.list")).json()).toEqual({ subagents: [] })
      expect(await (await call("provider.list")).json()).toEqual({ providers: [] })
      expect(await errorOf(await call("workflow.run", { name: "smoke" }))).toEqual({
        status: 409,
        code: "workflow_unavailable",
      })
    }))

  test("workflow.run bounds the name and the step limits, and refuses an unserializable result", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nifra-agent-workflow-bounds-"))
    await writeFile(
      join(cwd, "workflow.ts"),
      `export default ({ registerWorkflow }) => {
        registerWorkflow("smoke", () => ({ type: "task", id: "smoke", run: ({ set }) => set("answer", 42) }))
        registerWorkflow("big", () => ({ type: "task", id: "big", run: ({ set }) => set("answer", 1n) }))
      }`,
    )
    const extensions = new ExtensionHost({ cwd, roots: ["workflow.ts"] })
    const runWorkflow = extensions.runWorkflow.bind(extensions)
    const limits: { maxSteps?: number; maxDepth?: number }[] = []
    extensions.runWorkflow = (name, options) => {
      limits.push({ maxSteps: options?.maxSteps, maxDepth: options?.maxDepth })
      return runWorkflow(name, options)
    }
    try {
      await withRpc({ cwd, extensions }, async (call) => {
        expect((await call("session.create")).status).toBe(200)
        expect(await errorOf(await call("workflow.run", { name: "Not A Name" }))).toEqual({
          status: 422,
          code: "invalid_workflow",
        })
        const run = await call("workflow.run", { name: "smoke", maxSteps: 10_000, maxDepth: 99 })
        expect(run.status).toBe(200)
        expect(limits).toEqual([{ maxSteps: 512, maxDepth: 16 }])
        const big = await call("workflow.run", { name: "big" })
        expect(big.status).toBe(500)
        expect(await big.json()).toEqual({
          error: {
            code: "response_serialization_failed",
            message: "RPC response could not be serialized",
          },
        })
      })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

describe("coding agent RPC gate methods", () => {
  test("verification.run takes only a known gate and runs it in the project", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nifra-agent-verify-rpc-"))
    await writeFile(
      join(cwd, "pass.test.ts"),
      `import { test } from "bun:test"\ntest("passes", () => {})\n`,
    )
    try {
      await withRpc({ cwd }, async (call) => {
        expect(await errorOf(await call("verification.run", { name: "lint" }))).toEqual({
          status: 422,
          code: "invalid_verification",
        })
        expect((await call("session.create")).status).toBe(200)
        const run = await call("verification.run", { name: "test" })
        expect(run.status).toBe(200)
        expect(await run.json()).toMatchObject({ name: "test", ok: true, status: 0 })
      })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test("review.run refuses a non-boolean strict and an unsafe diff", () =>
    withRpc({}, async (call) => {
      expect(await errorOf(await call("review.run", { strict: "yes" }))).toEqual({
        status: 422,
        code: "invalid_review",
      })
      const unsafe = await call("review.run", { diff: "--output=/tmp/x" })
      expect(unsafe.status).toBe(422)
      expect(await unsafe.json()).toEqual({
        error: { code: "invalid_review", message: "diff must be a safe Git ref" },
      })
    }))
})
