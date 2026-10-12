import { describe, expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import { withRouteAssurance } from "../src/assurance.ts"
import { useCapability } from "../src/capabilities.ts"
import { effectLedger } from "../src/effect-ledger.ts"
import { idempotency } from "../src/idempotency-plugin.ts"
import { type Logger, RouteConfigError, server } from "../src/index.ts"
import { mcp } from "../src/mcp.ts"
import { nodeDirect } from "../src/node-direct.ts"
import { responseContract } from "../src/server/response-contract-lane.ts"
import { websocket } from "../src/ws.ts" // ws runtime, for the "merge refuses WebSocket groups" case

describe("merge - domain-group composition", () => {
  test("merged routes serve with the chains captured where they were DEFINED", async () => {
    const listings = server()
      .derive(() => ({ domain: "listings" }))
      .get("/listings", (c) => ({ from: c.domain }))
      .post("/listings", { body: t.object({ title: t.string() }) }, (c) => ({
        created: c.body.title,
        via: c.domain,
      }))
    const agents = server()
      .derive(() => ({ domain: "agents" }))
      .get("/agents/:id", (c) => ({ id: c.params.id, from: c.domain }))

    const app = server()
      .get("/health", () => ({ ok: true }))
      .merge(listings)
      .merge(agents)

    expect(await (await app.fetch(new Request("http://x/health"))).json()).toEqual({ ok: true })
    // Each group's own derive applies to its routes - not the parent's, not the other group's.
    expect(await (await app.fetch(new Request("http://x/listings"))).json()).toEqual({
      from: "listings",
    })
    expect(await (await app.fetch(new Request("http://x/agents/a7"))).json()).toEqual({
      id: "a7",
      from: "agents",
    })
    // Validation captured in the group still enforces on the merged app.
    const bad = await app.fetch(
      new Request("http://x/listings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: 7 }),
      }),
    )
    expect(bad.status).toBe(422)
  })

  test("merged routes use the executing server's runtime services in every lane", async () => {
    const parentLogs: string[] = []
    const groupLogs: string[] = []
    const logger = (sink: string[]): Logger => ({
      debug() {},
      info() {},
      warn() {},
      error(message) {
        sink.push(message)
      },
    })
    const group = server({ logger: logger(groupLogs) }).get("/merged-boom", () => {
      throw new Error("boom")
    })
    const app = server({ logger: logger(parentLogs) })
      .use(nodeDirect())
      .merge(group)

    expect((await app.fetch(new Request("http://x/merged-boom"))).status).toBe(500)
    const node = await app.resolveNode(new Request("http://x/merged-boom"))
    expect(node.kind).toBe("json")
    if (node.kind !== "json") throw new Error("unreachable")
    expect(node.status).toBe(500)
    expect(parentLogs).toEqual(["unhandled request error", "unhandled request error"])
    expect(groupLogs).toEqual([])
  })

  test("merged routes retain a group's opt-in idempotency and effect-ledger runtimes", async () => {
    let runs = 0
    const ledgers: unknown[] = []
    const group = server()
      .use(idempotency())
      .use(
        effectLedger({
          sink: (ledger) => {
            ledgers.push(ledger)
          },
        }),
      )
      .post(
        "/merged-pay",
        {
          capabilities: ["payments.charge"],
          idempotency: { scope: "request", namespace: "public:merged-pay" },
        },
        (c) => {
          runs += 1
          useCapability(c, "payments.charge")
          return { run: runs }
        },
      )
    const app = server().merge(group)
    const request = () =>
      new Request("http://x/merged-pay", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "merged-key" },
        body: "{}",
      })

    expect(await (await app.fetch(request())).json()).toEqual({ run: 1 })
    expect(await (await app.fetch(request())).json()).toEqual({ run: 1 })
    expect(runs).toBe(1)
    expect(ledgers).toHaveLength(1)
  })

  test("a group's onRequest hooks are scoped to the group's routes; introspection sees every route", async () => {
    const seen: string[] = []
    const group = server()
      .use({
        name: "group-hooks",
        onRequest: (req) => {
          seen.push(new URL(req.url).pathname)
          return undefined
        },
      })
      .get("/grouped", () => ({ ok: true }))
    const app = server()
      .get("/own", () => ({ ok: true }))
      .merge(group)

    await app.fetch(new Request("http://x/own"))
    await app.fetch(new Request("http://x/grouped"))
    // The hook runs where it was defined - the group's routes - never on the parent's.
    expect(seen).toEqual(["/grouped"])
    expect(app.routes().map((r) => `${r.method} ${r.path}`)).toEqual(["GET /own", "GET /grouped"])
  })

  test("a scoped group hook still short-circuits its own routes", async () => {
    const group = server()
      .use({
        name: "group-gate",
        onRequest: (req) =>
          req.headers.get("x-key") === null ? new Response(null, { status: 401 }) : undefined,
      })
      .get("/gated", () => ({ ok: true }))
    const app = server()
      .get("/open", () => ({ ok: true }))
      .merge(group)

    expect((await app.fetch(new Request("http://x/open"))).status).toBe(200)
    expect((await app.fetch(new Request("http://x/gated"))).status).toBe(401)
    expect(
      (await app.fetch(new Request("http://x/gated", { headers: { "x-key": "k" } }))).status,
    ).toBe(200)
  })

  test("a scoped group hook sees an OPTIONS request to a path the group serves, and only there", async () => {
    const seen: string[] = []
    const group = server()
      .use({
        name: "group-preflight",
        onRequest: (req) => {
          seen.push(`${req.method} ${new URL(req.url).pathname}`)
          return req.method === "OPTIONS" ? new Response(null, { status: 204 }) : undefined
        },
      })
      .post("/items", () => ({ ok: true }))
    const app = server()
      .get("/own", () => ({ ok: true }))
      .merge(group)

    const options = (path: string) =>
      app.fetch(new Request(`http://x${path}`, { method: "OPTIONS" }))
    expect((await options("/items")).status).toBe(204)
    expect((await options("/own")).status).toBe(405)
    expect((await options("/missing")).status).toBe(404)
    expect((await app.fetch(new Request("http://x/items"))).status).toBe(405)
    expect(seen).toEqual(["OPTIONS /items"])
  })

  test("a route-less group is a middleware bundle - its hooks apply app-wide, unchanged", async () => {
    const seen: string[] = []
    const bundle = server().use({
      name: "bundle-hooks",
      onRequest: (req) => {
        seen.push(new URL(req.url).pathname)
        return undefined
      },
    })
    const app = server()
      .get("/own", () => ({ ok: true }))
      .merge(bundle)

    await app.fetch(new Request("http://x/own"))
    expect(seen).toEqual(["/own"])
  })

  test("a group's global assurance follows its scoped hooks onto exactly the group's routes", async () => {
    const guard = withRouteAssurance(
      {
        name: "group-body-guard",
        onRequest: () => undefined,
      },
      { id: "nifra.body-bounded", source: "body-limit", scope: "global", methods: ["POST"] },
    )
    const group = server()
      .use(guard)
      .post("/uploads", () => ({ ok: true }))
    const app = server()
      .post("/own", () => ({ ok: true }))
      .merge(group)

    const byPath = new Map(app.routes().map((r) => [r.path, r.assurance]))
    expect(byPath.get("/uploads")?.some((e) => e.id === "nifra.body-bounded")).toBe(true)
    // The parent's own route never gains evidence for enforcement that no longer covers it.
    expect(byPath.get("/own")?.some((e) => e.id === "nifra.body-bounded") ?? false).toBe(false)
  })

  test("fail closed: route collisions and WebSocket groups are refused", () => {
    const group = server().get("/dup", () => ({}))
    expect(() =>
      server()
        .get("/dup", () => ({}))
        .merge(group),
    ).toThrow(RouteConfigError)

    const wsGroup = server()
      .use(websocket())
      .ws("/live", { message: () => {} })
    expect(() => server().merge(wsGroup)).toThrow(/WebSocket/)
  })

  test("a server holding mounts is refused, not merged without them", () => {
    const external = { fetch: () => new Response("external") }
    const withMount = server()
      .get("/own", () => ({}))
      .mount({ path: "/docs", app: external })
    const parent = server()
    expect(() => parent.merge(withMount)).toThrow(/mount/)
    expect(parent.routes()).toEqual([])
  })

  test("a failed multi-route merge leaves the parent unchanged", async () => {
    const parent = server().get("/taken", () => ({ parent: true }))
    const group = server()
      .get("/added", () => ({ ghost: true }))
      .get("/taken", () => ({ shadowed: true }))

    expect(() => parent.merge(group)).toThrow(RouteConfigError)
    expect(parent.routes().map(({ method, path }) => `${method} ${path}`)).toEqual(["GET /taken"])
    expect((await parent.fetch(new Request("http://x/added"))).status).toBe(404)
  })

  test("MCP tools/resources defined in a group survive the merge", () => {
    const group = server()
      .use(mcp())
      .tool(
        "echo",
        { description: "echo a value", input: t.object({ v: t.string() }) },
        (input) => ({ v: input.v }),
      )
    const app = server().merge(group)
    const toolRoute = app.routes().find((r) => r.tool?.name === "echo")
    expect(toolRoute).toBeDefined()
    expect(toolRoute?.path).toBe("/_nifra/tool/echo")
  })
})

/**
 * A parent's `.use()` of a registration-time runtime used to reach a `group()` route (the scope
 * inherits it) but not a `merge()`d one (compiled before it ever met the parent), so the same plugin
 * enforced one route and let its twin leak. Both runtimes only add a check or a record, so adoption
 * now recompiles a merged route under them.
 */
describe("merge - a parent's response contract and effect ledger", () => {
  const PublicUser = t.object({ id: t.string(), name: t.string() })
  const ROW = { id: "u1", name: "Ada", email: "a@b.c", passwordHash: "SECRET" }
  const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} }
  const get = (app: { fetch(request: Request): Promise<Response> | Response }, path: string) =>
    Promise.resolve(app.fetch(new Request(`http://x${path}`)))

  test("a merged route that declares a response is held to the parent's contract", async () => {
    const child = server({ logger: silent }).get("/me", { response: PublicUser }, () => ROW)
    const app = server({ logger: silent })
      .use(responseContract("enforce", { extra: "strip" }))
      .merge(child)
    const res = await get(app, "/me")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: "u1", name: "Ada" })
    const route = app.routes().find((candidate) => candidate.path === "/me")
    expect(route?.responseContract).toBe("enforce")
    expect(route?.assurance?.map((evidence) => evidence.id)).toContain("nifra.response-contract")
  })

  test("group() and merge() of the same route under the same parent now agree", async () => {
    const app = server({ logger: silent })
      .use(responseContract("enforce"))
      .group("/g", (group) => group.get("/me", { response: PublicUser }, () => ROW))
      .merge(server({ logger: silent }).get("/m/me", { response: PublicUser }, () => ROW))
    expect((await get(app, "/g/me")).status).toBe(500)
    expect((await get(app, "/m/me")).status).toBe(500)
  })

  test("a merged route keeps a contract its own server installed", async () => {
    const child = server({ logger: silent })
      .use(responseContract("warn"))
      .get("/me", { response: PublicUser }, () => ROW)
    const app = server({ logger: silent }).use(responseContract("enforce")).merge(child)
    const res = await get(app, "/me")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(ROW)
    expect(app.routes().find((candidate) => candidate.path === "/me")?.responseContract).toBe(
      "warn",
    )
  })

  test("a route with no response schema, and a contract installed after the merge, change nothing", async () => {
    const app = server({ logger: silent })
      .use(responseContract("enforce"))
      .merge(server({ logger: silent }).get("/raw", () => ROW))
    expect(await (await get(app, "/raw")).json()).toEqual(ROW)
    const late = server({ logger: silent })
      .merge(server({ logger: silent }).get("/me", { response: PublicUser }, () => ROW))
      .use(responseContract("enforce"))
    expect(await (await get(late, "/me")).json()).toEqual(ROW)
  })

  test("the Bun native lane serves the adopted contract over a real socket", async () => {
    const app = server({ logger: silent })
      .use(responseContract("enforce", { extra: "strip" }))
      .merge(server({ logger: silent }).get("/me", { response: PublicUser }, () => ROW))
    const running = app.listen(0, { hostname: "127.0.0.1" })
    try {
      const body = await (await fetch(`http://127.0.0.1:${running.port}/me`)).text()
      expect(JSON.parse(body)).toEqual({ id: "u1", name: "Ada" })
      expect(body).not.toContain("SECRET")
    } finally {
      await running.stop()
    }
  })

  test("a merged capability route records into the parent's effect ledger", async () => {
    const ledgers: unknown[] = []
    const child = server({ logger: silent }).post(
      "/pay",
      { capabilities: ["payments.charge"] },
      (c) => {
        useCapability(c, "payments.charge")
        return { ok: true }
      },
    )
    const app = server({ logger: silent })
      .use(effectLedger({ sink: (ledger) => void ledgers.push(ledger) }))
      .merge(child)
    const res = await app.fetch(new Request("http://x/pay", { method: "POST" }))
    expect(res.status).toBe(200)
    expect(ledgers).toHaveLength(1)
  })
})
