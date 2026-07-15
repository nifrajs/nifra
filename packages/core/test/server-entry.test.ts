import { describe, expect, test } from "bun:test"
import { server as rootServer } from "@nifrajs/core"
import { server } from "@nifrajs/core/server"

describe("@nifrajs/core/server", () => {
  test("keeps the server identity shared with the compatibility barrel", () => {
    expect(server).toBe(rootServer)
  })

  test("serves an app through the lean entry", async () => {
    const app = server().get("/health", () => ({ ok: true }))
    const response = await app.fetch(new Request("http://nifra.test/health"))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  test("does not expose opt-in runtime systems", async () => {
    const entry: Record<string, unknown> = await import("@nifrajs/core/server")

    expect(entry.createSeededRandom).toBeUndefined()
    expect(entry.canonicalManifest).toBeUndefined()
    expect(entry.startCausality).toBeUndefined()
    expect(entry.reflectRoutes).toBeUndefined()
  })
})
