import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { runWebSocket } from "../src/mcp-ws.ts"

const BACKEND = [
  'import "@nifrajs/core/ws"',
  'import { server } from "@nifrajs/core"',
  "export const backend = server()",
  '  .ws("/echo", {',
  '    open: (ws) => ws.send("welcome"),',
  '    message: (ws, data) => ws.send("echo:" + String(data)),',
  "  })",
  '  .ws("/guarded", {',
  "    upgrade: (c) => {",
  '      const token = new URL(c.req.url).searchParams.get("token")',
  '      if (token !== "secret") return new Response("unauthorized", { status: 401 })',
  "      return { token }",
  "    },",
  '    open: (ws) => ws.send("hi " + ws.data.token),',
  "  })",
  "",
].join("\n")

async function withBackend<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(process.cwd(), ".tmp-nifra-ws-"))
  try {
    await writeFile(join(dir, "backend.ts"), BACKEND)
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("runWebSocket (nifra_ws engine)", () => {
  test("verifies a live WebSocket open + message round-trip", async () => {
    await withBackend(async (cwd) => {
      const res = await runWebSocket(cwd, {
        path: "/echo",
        messages: ["hi"],
        expectMessages: 2,
      })

      expect(res).toMatchObject({
        ok: true,
        opened: true,
        path: "/echo",
        sent: ["hi"],
        received: ["welcome", "echo:hi"],
      })
      expect(res.url?.startsWith("ws://127.0.0.1:")).toBe(true)
    })
  })

  test("verifies guarded routes with query strings", async () => {
    await withBackend(async (cwd) => {
      const res = await runWebSocket(cwd, { path: "/guarded?token=secret" })
      expect(res).toMatchObject({
        ok: true,
        opened: true,
        received: ["hi secret"],
      })
    })
  })

  test("reports rejected upgrades without hanging", async () => {
    await withBackend(async (cwd) => {
      const res = await runWebSocket(cwd, { path: "/guarded", timeoutMs: 1_000 })
      expect(res.ok).toBe(false)
      expect(res.opened).toBe(false)
      expect(res.error).toContain("websocket")
    })
  })

  test("rejects non-local targets", async () => {
    const res = await runWebSocket(process.cwd(), { path: "wss://example.com/ws" })
    expect(res).toMatchObject({
      ok: false,
      opened: false,
      error: 'expected "path" to be an app-local path such as "/ws"',
    })
  })

  test("child entry emits parseable JSON for the MCP subprocess", async () => {
    await withBackend(async (cwd) => {
      const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/mcp-ws.ts"), cwd], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      })
      proc.stdin.write(JSON.stringify({ path: "/guarded?token=secret" }))
      await proc.stdin.end()

      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      expect(code).toBe(0)
      expect(err).toBe("")
      expect(JSON.parse(out)).toMatchObject({
        ok: true,
        opened: true,
        received: ["hi secret"],
      })
    })
  })
})
