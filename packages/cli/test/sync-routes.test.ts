import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { syncRouteTypes } from "../src/sync-routes.ts"

test("nifra sync-routes writes a route-types .d.ts for static routes only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nifra-syncroutes-"))
  try {
    const routesDir = join(dir, "routes")
    await mkdir(join(routesDir, "users"), { recursive: true })
    await writeFile(join(routesDir, "index.tsx"), "export default () => null")
    await writeFile(join(routesDir, "reports.tsx"), "export default () => null")
    await writeFile(join(routesDir, "users", "[id].tsx"), "export default () => null") // dynamic

    const first = await syncRouteTypes(dir)
    expect(first?.changed).toBe(true)
    expect(first?.typedRoutes).toBe(2)

    const code = await readFile(join(dir, "nifra-routes.d.ts"), "utf8")
    expect(code).toContain('declare module "@nifrajs/web"')
    expect(code).toContain("interface RouteSearch {")
    expect(code).toContain('"/": SearchOf<typeof import("./routes/index")>')
    expect(code).toContain('"/reports": SearchOf<typeof import("./routes/reports")>')
    // The dynamic route (`:id`) is excluded - its pattern is not a concrete `to`.
    expect(code).not.toContain("/users/:id")

    // Idempotent: a second run with no route changes rewrites nothing.
    const second = await syncRouteTypes(dir)
    expect(second?.changed).toBe(false)
    expect(second?.typedRoutes).toBe(2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("nifra sync-routes returns null when there is no routes/ directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nifra-syncroutes-empty-"))
  try {
    expect(await syncRouteTypes(dir)).toBeNull()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
