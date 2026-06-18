import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { renderPages } from "../src/mcp-render.ts"

// A real, in-workspace nifra React app (framework.ts + routes/ + backend.ts) — the faithful fixture.
const APP = join(import.meta.dir, "../../../examples/cli-react")

type RenderResult = Awaited<ReturnType<typeof renderPages>>
type PageResult = { status: number; body?: unknown; path?: string }
const isErr = (r: RenderResult): r is { error: string } => "error" in r

describe("renderPages", () => {
  test("SSRs a real page route to HTML (loader runs), 404s an unknown path", async () => {
    const r = await renderPages(APP, [{ path: "/" }, { path: "/no-such-page" }])
    expect(isErr(r)).toBe(false)
    if (isErr(r)) return
    const [home, missing] = r.results as PageResult[]
    expect(home?.status).toBe(200)
    const html = typeof home?.body === "string" ? home.body : String(home?.body ?? "")
    expect(html.length).toBeGreaterThan(50)
    expect(/<(?:!doctype|html|main|div|h1|button)/i.test(html)).toBe(true) // real server-rendered markup
    expect(missing?.status).toBe(404)
  })

  test("non-array requests → actionable error, never throws", async () => {
    const r = await renderPages(APP, "nope" as unknown)
    expect(isErr(r)).toBe(true)
    if (isErr(r)) expect(r.error).toContain("expected { requests")
  })

  test("a project with no nifra config → actionable error (not a crash)", async () => {
    const r = await renderPages(join(import.meta.dir, ".."), [{ path: "/" }]) // packages/cli — no config
    expect(isErr(r)).toBe(true)
  })
})
