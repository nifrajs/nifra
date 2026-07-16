import { describe, expect, test } from "bun:test"
import { server as rootServer } from "@nifrajs/core"
import { server } from "@nifrajs/core/server"

describe("@nifrajs/core/server", () => {
  test("shares the server identity with the lean package root", () => {
    expect(server).toBe(rootServer)
  })

  test("serves an app through the lean entry", async () => {
    const app = server().get("/health", () => ({ ok: true }))
    const response = await app.fetch(new Request("http://nifra.test/health"))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  test("does not expose opt-in runtime systems", async () => {
    const root: Record<string, unknown> = await import("@nifrajs/core")
    const entry: Record<string, unknown> = await import("@nifrajs/core/server")

    for (const module of [root, entry]) {
      expect(module.canonicalManifest).toBeUndefined()
      expect(module.startCausality).toBeUndefined()
      expect(module.reflectRoutes).toBeUndefined()
      expect(module.sse).toBeUndefined()
      expect(module.idempotency).toBeUndefined()
      expect(module.effectLedger).toBeUndefined()
    }
  })

  test("MCP declarations fail with actionable guidance until the MCP runtime is imported", async () => {
    const script = `
      import { server } from "@nifrajs/core/server"
      const input = { "~standard": { version: 1, vendor: "test", validate: value => ({ value }) } }
      try { server().tool("ping", { description: "Ping", input }, () => ({ ok: true })) }
      catch (error) { console.log(error.code + " " + error.message) }
    `
    const proc = Bun.spawn([process.execPath, "--eval", script], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    })
    const stdout = await new Response(proc.stdout).text()
    expect(await proc.exited).toBe(0)
    expect(stdout).toContain("MCP_RUNTIME_MISSING")
    expect(stdout).toContain(".use(mcp())")
  })
})
