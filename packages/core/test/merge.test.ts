import { describe, expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import { RouteConfigError, server } from "../src/index.ts"
import "../src/ws.ts" // ws runtime, for the "merge refuses WebSocket groups" case

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

  test("MCP tools/resources defined in a group survive the merge", () => {
    const group = server().tool(
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
