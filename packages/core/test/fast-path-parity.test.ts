import { describe, expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import { server } from "../src/index.ts"

type RequestFactory = () => Request

interface ObservedResponse {
  readonly status: number
  readonly contentType: string | null
  readonly body: string
}

async function observe(
  app: { fetch(request: Request): Response | Promise<Response> },
  make: RequestFactory,
): Promise<ObservedResponse> {
  const response = await app.fetch(make())
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: await response.text(),
  }
}

async function expectEquivalent(
  fast: { fetch(request: Request): Response | Promise<Response> },
  general: { fetch(request: Request): Response | Promise<Response> },
  requests: readonly RequestFactory[],
): Promise<void> {
  for (const make of requests) {
    expect(await observe(fast, make)).toEqual(await observe(general, make))
  }
}

describe("fast-path semantic parity", () => {
  test("bare routes match the general route program", async () => {
    const handler = () => ({ lane: "bare", value: "ok" })
    const fast = server().get("/parity", handler)
    const general = server()
      .beforeHandle(() => undefined)
      .get("/parity", handler)

    await expectEquivalent(fast, general, [() => new Request("http://x/parity")])
  })

  test("query validation and failures match the general route program", async () => {
    const schema = t.object({ q: t.string({ minLength: 2 }) })
    const handler = (context: { query: { q: string } }) => ({ q: context.query.q })
    const fast = server().get("/parity", { query: schema }, handler)
    const general = server()
      .beforeHandle(() => undefined)
      .get("/parity", { query: schema }, handler)

    await expectEquivalent(fast, general, [
      () => new Request("http://x/parity?q=ada"),
      () => new Request("http://x/parity?q=x"),
      () => new Request("http://x/parity"),
    ])
  })

  test("body validation and failures match the general route program", async () => {
    const schema = t.object({ name: t.string({ minLength: 2 }) })
    const handler = (context: { body: { name: string } }) => ({ name: context.body.name })
    const fast = server().post("/parity", { body: schema }, handler)
    const general = server()
      .beforeHandle(() => undefined)
      .post("/parity", { body: schema }, handler)
    const request = (body: unknown): Request =>
      new Request("http://x/parity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })

    await expectEquivalent(fast, general, [
      () => request({ name: "Ada" }),
      () => request({ name: "x" }),
      () => request({}),
    ])
  })

  test("fused lifecycle hooks match the general route program", async () => {
    const makeApp = (withAround: boolean) => {
      let app = withAround ? server().around((_context, next) => next()) : server()
      app = app
        .derive(() => ({ user: "ada" }))
        .beforeHandle(() => undefined)
        .get("/parity", (context) => ({ user: context.user }))
      return app
    }

    const fast = makeApp(false)
    const general = makeApp(true)
    await expectEquivalent(fast, general, [() => new Request("http://x/parity")])
  })
})
