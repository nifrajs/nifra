import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { nodeDirect } from "@nifrajs/core/node-direct"
import { poweredBy } from "../src/index.ts"

describe("poweredBy()", () => {
  test("sets an opt-in powered-by header", async () => {
    const app = server()
      .use(poweredBy())
      .get("/", () => ({ ok: true }))

    const res = await app.fetch(new Request("http://x/"))
    expect(res.headers.get("x-powered-by")).toBe("Nifra")
  })

  test("respects existing headers unless configured to override", async () => {
    const respected = server()
      .use(poweredBy({ value: "Nifra" }))
      .get("/", () => new Response("ok", { headers: { "x-powered-by": "app" } }))
    expect((await respected.fetch(new Request("http://x/"))).headers.get("x-powered-by")).toBe(
      "app",
    )

    const overridden = server()
      .use(poweredBy({ value: "Nifra", respectExisting: false }))
      .get("/", () => new Response("ok", { headers: { "x-powered-by": "app" } }))
    expect((await overridden.fetch(new Request("http://x/"))).headers.get("x-powered-by")).toBe(
      "Nifra",
    )
  })

  test("validates construction", () => {
    expect(() => poweredBy({ header: "" })).toThrow(/header/)
    expect(() => poweredBy({ value: "bad\nvalue" })).toThrow(/newline/)
  })

  test("header-only output stays on the Node-direct outcome lane", async () => {
    const app = server()
      .use(nodeDirect())
      .use(poweredBy())
      .get("/", () => ({ ok: true }))
    const outcome = await app.resolveNode(new Request("http://x/"))
    expect(outcome.kind).toBe("json")
    if (outcome.kind !== "json") throw new Error("unreachable")
    expect(outcome.headers?.["x-powered-by"]).toBe("Nifra")
  })
})
