import { describe, expect, test } from "bun:test"
import {
  scanFetchText,
  scanResponseRoutes,
  scanServerOnlyImports,
  scanStaticRouteText,
  stripComments,
} from "../src/check-scan.ts"

describe("check-scan", () => {
  test("strips comments and template code without changing offsets", () => {
    const source = '// fetch("/comment")\nconst x = `fetch("/template")`\nfetch("/real")'
    const stripped = stripComments(source)
    expect(stripped.length).toBe(source.length)
    expect(stripped.slice(0, source.indexOf('fetch("/real")'))).not.toContain("/comment")
    expect(stripped).toContain('fetch("/real")')
  })

  test("finds same-origin fetches while honoring external mounts", () => {
    const findings = scanFetchText(
      "routes/index.tsx",
      'fetch("/users")\nfetch("/auth/session")\nfetch("https://example.test/users")',
      ["/auth"],
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]?.line).toBe(1)
  })

  test("keeps server-only import scanning scoped to route modules", () => {
    expect(scanServerOnlyImports("routes/users.tsx", 'import fs from "node:fs"')).toHaveLength(1)
    expect(scanServerOnlyImports("server/db.ts", 'import fs from "node:fs"')).toEqual([])
  })

  test("extracts static backend routes and raw-response advisories", () => {
    const source = 'server().get("/users", () => Response.json({ ok: true }))'
    expect(scanStaticRouteText("backend.ts", source)).toMatchObject([
      { method: "GET", path: "/users", line: 1 },
    ])
    expect(scanResponseRoutes("backend.ts", source)).toMatchObject([{ line: 1 }])
  })
})
