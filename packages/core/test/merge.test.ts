import { describe, expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import { useCapability } from "../src/capabilities.ts"
import { effectLedger } from "../src/effect-ledger.ts"
import { idempotency } from "../src/idempotency-plugin.ts"
import { type Logger, RouteConfigError, server } from "../src/index.ts"
import "../src/ws.ts" // ws runtime, for the "merge refuses WebSocket groups" case
import { mcp } from "../src/mcp.ts"
import { nodeDirect } from "../src/node-direct.ts"

describe("merge — domain-group composition", () => {
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
    // Each group's own derive applies to its routes — not the parent's, not the other group's.
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
    expect(node.kind).toBe("response")
    if (node.kind !== "response") throw new Error("unreachable")
    expect(node.response.status).toBe(500)
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

  test("a group's request-level hooks ride along; introspection sees every route", async () => {
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
    expect(seen).toEqual(["/own", "/grouped"]) // onRequest is global — appended to the parent
    expect(app.routes().map((r) => `${r.method} ${r.path}`)).toEqual(["GET /own", "GET /grouped"])
  })

  test("fail closed: route collisions and WebSocket groups are refused", () => {
    const group = server().get("/dup", () => ({}))
    expect(() =>
      server()
        .get("/dup", () => ({}))
        .merge(group),
    ).toThrow(RouteConfigError)

    const wsGroup = server().ws("/live", { message: () => {} })
    expect(() => server().merge(wsGroup)).toThrow(/WebSocket/)
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
