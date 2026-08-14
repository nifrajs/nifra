import { describe, expect, test } from "bun:test"
import type { Logger } from "../src/index.ts"
import { FrameworkError, server } from "../src/index.ts"
import { nodeDirect } from "../src/node-direct.ts"

/** Capture `console.warn` for one act, restoring it after. Returns every message it received. */
const withWarnSpy = async (act: () => unknown | Promise<unknown>): Promise<string[]> => {
  const original = console.warn
  const messages: string[] = []
  console.warn = (...args: unknown[]): void => {
    messages.push(String(args[0]))
  }
  try {
    await act()
  } finally {
    console.warn = original
  }
  return messages
}

const GET = (path: string): Request => new Request(`http://x${path}`)

describe("unused order-scoped hooks", () => {
  test("derive() after the only route warns, naming the hook and the count", async () => {
    const app = server().get("/a", () => "ok")
    app.derive(() => ({ n: 1 }))
    const warnings = await withWarnSpy(() => app.fetch(GET("/a")))
    expect(warnings.length).toBe(1)
    const [message] = warnings
    expect(message).toContain("1 order-scoped hook(s)")
    expect(message).toContain("derive()")
  })

  test("derive() before the route is silent", async () => {
    const app = server()
    app.derive(() => ({ n: 1 }))
    const withRoute = app.get("/a", () => "ok")
    const warnings = await withWarnSpy(() => withRoute.fetch(GET("/a")))
    expect(warnings.length).toBe(0)
  })

  test("legitimate group scoping does not warn (the no-false-positive case)", async () => {
    const app = server()
      .get("/public", () => "ok")
      .beforeHandle(() => undefined)
      .get("/private", () => "ok")
    const warnings = await withWarnSpy(() => app.fetch(GET("/public")))
    expect(warnings.length).toBe(0)
  })

  test("every order-scoped hook added after routes is named in one combined message", async () => {
    const app = server().get("/a", () => "ok")
    app.derive(() => ({ d: 1 }))
    app.decorate("k", 1)
    app.beforeHandle(() => undefined)
    app.afterHandle((result) => result)
    app.around((_c, next) => next())
    app.aroundCapability((_event, next) => next())
    app.onError(() => undefined)

    const warnings = await withWarnSpy(() => app.fetch(GET("/a")))
    expect(warnings.length).toBe(1)
    const [message] = warnings
    expect(message).toContain("7 order-scoped hook(s)")
    for (const kind of [
      "derive",
      "decorate",
      "beforeHandle",
      "afterHandle",
      "around",
      "aroundCapability",
      "onError",
    ]) {
      expect(message).toContain(`${kind}()`)
    }
  })

  test('unusedScopedHooks: "error" throws FrameworkError(UNUSED_SCOPED_HOOKS)', () => {
    const app = server({ unusedScopedHooks: "error" }).get("/a", () => "ok")
    app.derive(() => ({ n: 1 }))
    let caught: unknown
    try {
      app.fetch(GET("/a"))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(FrameworkError)
    expect((caught as FrameworkError).code).toBe("UNUSED_SCOPED_HOOKS")
  })

  test('unusedScopedHooks: "off" is silent for a hook that would otherwise warn', async () => {
    const app = server({ unusedScopedHooks: "off" }).get("/a", () => "ok")
    app.derive(() => ({ n: 1 }))
    const warnings = await withWarnSpy(() => app.fetch(GET("/a")))
    expect(warnings.length).toBe(0)
  })

  test("fires once across repeated fetch() with no listen()", async () => {
    const app = server().get("/a", () => "ok")
    app.derive(() => ({ n: 1 }))
    const warnings = await withWarnSpy(async () => {
      await app.fetch(GET("/a"))
      await app.fetch(GET("/a"))
      await app.fetch(GET("/a"))
    })
    expect(warnings.length).toBe(1)
  })

  test("fires on the resolveNode() Node-direct lane the same way", async () => {
    const app = server()
      .use(nodeDirect())
      .get("/a", () => "ok")
    app.derive(() => ({ n: 1 }))
    const warnings = await withWarnSpy(async () => {
      await app.resolveNode(GET("/a"))
      await app.resolveNode(GET("/a"))
    })
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain("derive()")
  })

  test("an app with zero routes and one derive is silent", async () => {
    const app = server()
    app.derive(() => ({ n: 1 }))
    const warnings = await withWarnSpy(() => app.fetch(GET("/missing")))
    expect(warnings.length).toBe(0)
  })

  test("routes added via registerBatch count toward coverage", async () => {
    // A derive BEFORE a batch is covered by the batch's routes - proving the batch bumps the count.
    const app = server()
    app.derive(() => ({ n: 1 }))
    app.registerBatch([{ method: "GET", path: "/b", schema: undefined, handler: () => "ok" }])
    const covered = await withWarnSpy(() => app.fetch(GET("/b")))
    expect(covered.length).toBe(0)

    // A derive AFTER the batch is dead.
    const app2 = server()
    app2.registerBatch([{ method: "GET", path: "/b", schema: undefined, handler: () => "ok" }])
    app2.derive(() => ({ n: 1 }))
    const dead = await withWarnSpy(() => app2.fetch(GET("/b")))
    expect(dead.length).toBe(1)
    expect(dead[0]).toContain("derive()")
  })

  test("merge() does not spuriously warn: a parent hook covering the parent route is accurate", async () => {
    const child = server().get("/c", () => "ok")
    const parent = server()
    parent.derive(() => ({ n: 1 }))
    const withRoute = parent.get("/p", () => "ok")
    withRoute.merge(child)
    const warnings = await withWarnSpy(() => withRoute.fetch(GET("/p")))
    expect(warnings.length).toBe(0)
  })

  test("emits through a configured logger, not console.warn", async () => {
    const seen: string[] = []
    const logger: Logger = {
      debug: () => {},
      info: () => {},
      warn: (message) => seen.push(message),
      error: () => {},
    }
    const app = server({ logger }).get("/a", () => "ok")
    app.derive(() => ({ n: 1 }))
    const consoleWarnings = await withWarnSpy(() => app.fetch(GET("/a")))
    expect(consoleWarnings.length).toBe(0)
    expect(seen.length).toBe(1)
    expect(seen[0]).toContain("derive()")
  })
})
