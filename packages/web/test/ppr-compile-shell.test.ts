import { describe, expect, test } from "bun:test"
import { discoverRoutes } from "../src/fs.ts"
import { compileShells, ShellCheckError } from "../src/internal/ppr/compile-shell.ts"

const routesDir = `${import.meta.dir}/fixtures/ppr/shell-routes`
const requestScoped = (id: string): boolean => id.endsWith("/shell-lib/session.ts")

describe("compileShells", () => {
  test("records clean shells, refuses a leaky one with its import chain, skips routes without shellLoader", async () => {
    const failures: Array<[string, unknown]> = []
    const record = await compileShells({
      routesDir,
      manifest: discoverRoutes(routesDir),
      deployment: "d1",
      requestScoped,
      onFailure: (routeId, error) => failures.push([routeId, error]),
    })
    expect(record.v).toBe(1)
    expect(record.deployment).toBe("d1")
    expect(Object.keys(record.routes).sort()).toEqual([
      "ambient-hole",
      "clean",
      "gated/[id]",
      "nested/[id]",
      "shared-hole",
    ])
    expect(record.routes.clean).toMatch(/^[0-9a-f]{64}$/)
    // Only a shared entry written inline, with revalidate, is checked, so only that one is stored.
    expect(record.sharedHoles).toEqual({ "shared-hole": ["price"] })
    const failed = new Map(failures)
    expect([...failed.keys()].sort()).toEqual([
      "ambient",
      "layout-meta/[id]",
      "leaky",
      "loaded/[id]",
      "meta-leak",
      "platform-env",
      "shared-leak",
    ])
    // The shell renders meta too: a read only a page's or a layout's meta makes fails the route.
    for (const id of ["meta-leak", "layout-meta/[id]"]) {
      const error = failed.get(id)
      expect(error instanceof ShellCheckError ? error.chain.at(-1) : "").toEndWith(
        "/shell-lib/session.ts",
      )
    }
    // A shared hole's loader is part of the shell, so its request read fails the route.
    const sharedLeak = failed.get("shared-leak")
    expect(sharedLeak instanceof ShellCheckError ? sharedLeak.chain.at(-1) : "").toEndWith(
      "/shell-lib/session.ts",
    )
    // A Worker's env reaches a module through an import, with no request: it counts too.
    const platform = failed.get("platform-env")
    expect(platform instanceof ShellCheckError ? platform.chain.at(-1) : "").toEndWith(
      "/shell-routes/platform-env.backend.ts",
    )
    expect(String(failed.get("loaded/[id]"))).toContain(
      'route "loaded/[id]" has a shellLoader, but its layout "loaded/_layout" has a loader that is not a gate',
    )
    // nifra's own async-context accessor counts without the app listing it.
    const ambient = failed.get("ambient")
    expect(ambient).toBeInstanceOf(ShellCheckError)
    expect(ambient instanceof ShellCheckError ? ambient.chain.at(-1) : "").toEndWith(
      "/middleware/src/context-storage.ts",
    )
    const [routeId, error] = failures.find(([id]) => id === "leaky") ?? []
    expect(routeId).toBe("leaky")
    expect(error).toBeInstanceOf(ShellCheckError)
    const chain = error instanceof ShellCheckError ? error.chain : []
    expect(chain.at(0)).toEndWith("/shell-routes/leaky.backend.ts")
    expect(chain.at(-1)).toEndWith("/shell-lib/session.ts")
  })

  test("without onFailure the first failing route throws", async () => {
    await expect(
      compileShells({
        routesDir,
        manifest: discoverRoutes(routesDir),
        deployment: "d1",
        requestScoped,
      }),
    ).rejects.toBeInstanceOf(ShellCheckError)
  })

  test("the bundle hash is stable across runs", async () => {
    const run = () =>
      compileShells({
        routesDir,
        manifest: discoverRoutes(routesDir),
        deployment: "d1",
        requestScoped,
        onFailure: () => {},
      })
    expect((await run()).routes).toEqual((await run()).routes)
  })
})
