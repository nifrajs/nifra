import { describe, expect, test } from "bun:test"
import { t } from "../../schema/src/index.ts"
import { effectLedger } from "../src/effect-ledger.ts"
import type { Logger } from "../src/index.ts"
import { type AuthenticationStage, authenticated, FrameworkError, server } from "../src/index.ts"
import { nodeDirect } from "../src/node-direct.ts"
import { responseContract } from "../src/server/response-contract-lane.ts"
import { websocket } from "../src/ws.ts"

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

  test("a guard followed only by a socket applies to its handshake and does not warn", async () => {
    const app = server()
      .use(websocket())
      .get("/a", () => "ok")
      .beforeHandle(() => undefined)
      .derive(() => ({ user: "u1" }))
      .ws("/socket", {})
    const warnings = await withWarnSpy(() => app.fetch(GET("/a")))
    expect(warnings).toEqual([])
  })

  test("afterHandle() and around() followed only by a socket still warn: a handshake runs neither", async () => {
    const app = server()
      .use(websocket())
      .get("/a", () => "ok")
      .afterHandle((result) => result)
      .around((_c, next) => next())
      .ws("/socket", {})
    const warnings = await withWarnSpy(() => app.fetch(GET("/a")))
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain("2 order-scoped hook(s)")
    expect(warnings[0]).toContain("afterHandle()")
    expect(warnings[0]).toContain("around()")
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

const session: AuthenticationStage<{ readonly id: string }> = {
  id: "session",
  run: () => authenticated({ id: "u1" }),
}

describe("hooks followed only by merged routes", () => {
  test("a derive followed only by merges is dead, and the message says merge is why", async () => {
    const child = server().get("/c", () => "ok")
    const app = server()
      .derive(() => ({ user: "u1" }))
      .merge(child)
    const warnings = await withWarnSpy(() => app.fetch(GET("/c")))
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain("derive()")
    expect(warnings[0]).toContain("(only merge()d routes follow it)")
    expect(warnings[0]).toContain("A merge()d route keeps the hooks of the server that declared it")
  })

  test("a parent hook that also covers a later own route is silent", async () => {
    const child = server().get("/c", () => "ok")
    const app = server()
      .derive(() => ({ user: "u1" }))
      .merge(child)
      .get("/p", () => "ok")
    const warnings = await withWarnSpy(() => app.fetch(GET("/p")))
    expect(warnings).toEqual([])
  })

  test("a group() after the hook covers it: group routes inherit the chain", async () => {
    const child = server().get("/c", () => "ok")
    const app = server()
      .beforeHandle(() => undefined)
      .merge(child)
      .group("/g", (g) => g.get("/x", () => "ok"))
    const warnings = await withWarnSpy(() => app.fetch(GET("/g/x")))
    expect(warnings).toEqual([])
  })

  test("authenticate() after the last route is reported", async () => {
    const app = server().get("/a", () => "ok")
    app.authenticate(session)
    const warnings = await withWarnSpy(() => app.fetch(GET("/a")))
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain("authenticate()")
  })

  test("authenticate() followed only by merges is reported in error mode", () => {
    const child = server().get("/c", () => "ok")
    const app = server({ unusedScopedHooks: "error" }).authenticate(session).merge(child)
    expect(() => app.fetch(GET("/c"))).toThrow("(only merge()d routes follow it)")
  })
})

describe("registration-time plugins installed after the routes they cover", () => {
  const typed = { response: t.object({ id: t.string() }) }

  test("responseContract() after a route with a response schema warns, naming the route", async () => {
    const app = server().get("/a", typed, () => ({ id: "1" }))
    app.use(responseContract("enforce"))
    const warnings = await withWarnSpy(() => app.fetch(GET("/a")))
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain("responseContract() at ")
    expect(warnings[0]).toContain("1 route(s) it would have covered: GET /a")
  })

  test("responseContract() after a merge warns for the merged routes", async () => {
    const child = server().get("/c", typed, () => ({ id: "1" }))
    const app = server().merge(child)
    app.use(responseContract("enforce"))
    const warnings = await withWarnSpy(() => app.fetch(GET("/c")))
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain("GET /c")
  })

  test("responseContract() before the routes and merges is silent", async () => {
    const child = server().get("/c", typed, () => ({ id: "1" }))
    const app = server()
      .use(responseContract("enforce"))
      .merge(child)
      .get("/a", typed, () => ({ id: "1" }))
    const warnings = await withWarnSpy(() => app.fetch(GET("/a")))
    expect(warnings).toEqual([])
  })

  test("routes without a response schema do not count", async () => {
    const app = server().get("/health", () => "ok")
    app.use(responseContract("enforce"))
    const warnings = await withWarnSpy(() => app.fetch(GET("/health")))
    expect(warnings).toEqual([])
  })

  test("a merged route that already has its own contract does not count", async () => {
    const child = server()
      .use(responseContract("enforce"))
      .get("/c", typed, () => ({ id: "1" }))
    const app = server().merge(child)
    app.use(responseContract("warn"))
    const warnings = await withWarnSpy(() => app.fetch(GET("/c")))
    expect(warnings).toEqual([])
  })

  test("the route list is capped at five with a count of the rest", async () => {
    const app = server()
    for (let i = 0; i < 7; i++) app.get(`/r${i}`, typed, () => ({ id: "1" }))
    app.use(responseContract("enforce"))
    const warnings = await withWarnSpy(() => app.fetch(GET("/r0")))
    expect(warnings[0]).toContain("7 route(s)")
    expect(warnings[0]).toContain("GET /r4 and 2 more")
  })

  test("effectLedger() after a capability-declaring route warns", async () => {
    const app = server().post("/write", { capabilities: ["db.write"] }, () => "ok")
    app.use(effectLedger({ sink() {} }))
    const warnings = await withWarnSpy(() => app.fetch(GET("/write")))
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain("effectLedger() at ")
    expect(warnings[0]).toContain("POST /write")
  })

  test('unusedScopedHooks: "error" throws for a late install', () => {
    const app = server({ unusedScopedHooks: "error" }).get("/a", typed, () => ({ id: "1" }))
    app.use(responseContract("enforce"))
    expect(() => app.fetch(GET("/a"))).toThrow("installed after 1 route(s)")
  })

  test('unusedScopedHooks: "off" records nothing', async () => {
    const app = server({ unusedScopedHooks: "off" }).get("/a", typed, () => ({ id: "1" }))
    app.use(responseContract("enforce"))
    const warnings = await withWarnSpy(() => app.fetch(GET("/a")))
    expect(warnings).toEqual([])
  })

  test("a dead hook and a late install share one message", async () => {
    const app = server().get("/a", typed, () => ({ id: "1" }))
    app.derive(() => ({ n: 1 }))
    app.use(responseContract("enforce"))
    const warnings = await withWarnSpy(() => app.fetch(GET("/a")))
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain("derive()")
    expect(warnings[0]).toContain("responseContract() at ")
  })
})
