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
    expect(Object.keys(record.routes).sort()).toEqual(["clean", "gated/[id]", "nested/[id]"])
    expect(record.routes.clean).toMatch(/^[0-9a-f]{64}$/)
    expect(failures.map(([id]) => id)).toEqual(["leaky", "loaded/[id]"])
    expect(String(failures[1]?.[1])).toContain(
      'route "loaded/[id]" has a shellLoader, but its layout "loaded/_layout" has a loader that is not a gate',
    )
    const [routeId, error] = failures[0] ?? []
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
