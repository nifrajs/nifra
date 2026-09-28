import { describe, expect, test } from "bun:test"
import { t } from "../../schema/src/index.ts"
import { server } from "../src/index.ts"
import { responseContract } from "../src/server/response-contract-lane.ts"

describe("mountFetch", () => {
  test("composed mounts run before parent catch-all routes", async () => {
    const app = server()
      .mount({
        path: "/api",
        app: { fetch: () => Response.json({ source: "mount" }) },
      })
      .get("/*", () => ({ source: "page" }))

    const response = await app.fetch(new Request("http://test/api/health"))
    expect(await response.json()).toEqual({ source: "mount" })
  })

  test("priority and safe 404 fallthrough select the next same-prefix mount", async () => {
    let fallbackCalls = 0
    const app = server()
      .mount({
        path: "/api",
        priority: 10,
        fallbackOn: 404,
        app: { fetch: () => new Response(null, { status: 404 }) },
      })
      .mount({
        path: "/api",
        priority: 0,
        app: {
          fetch: () => {
            fallbackCalls += 1
            return Response.json({ source: "fallback" })
          },
        },
      })

    const response = await app.fetch(new Request("http://test/api/item"))
    expect(await response.json()).toEqual({ source: "fallback" })
    expect(fallbackCalls).toBe(1)
  })

  test("never retries a non-replayable body mount after a 404", async () => {
    let nextCalls = 0
    const app = server()
      .mount({
        path: "/webhook",
        fallbackOn: 404,
        app: { fetch: () => new Response(null, { status: 404 }) },
      })
      .mount({
        path: "/webhook",
        app: {
          fetch: () => {
            nextCalls += 1
            return Response.json({ source: "second" })
          },
        },
      })

    const response = await app.fetch(
      new Request("http://test/webhook", { method: "POST", body: "payload" }),
    )
    expect(response.status).toBe(404)
    expect(nextCalls).toBe(0)
  })

  test("matches a prefix and optionally strips it before invocation", async () => {
    const seen: string[] = []
    const app = server()
      .mountFetch("/legacy/*", (request) => {
        const path = new URL(request.url).pathname
        seen.push(path)
        return new Response(path)
      })
      .mountFetch("/stripped/*", (request) => new Response(new URL(request.url).pathname), {
        stripPrefix: true,
      })

    expect(await (await app.fetch(new Request("http://test/legacy/users"))).text()).toBe(
      "/legacy/users",
    )
    expect(await (await app.fetch(new Request("http://test/stripped/users"))).text()).toBe("/users")
    expect(await (await app.fetch(new Request("http://test/stripped"))).text()).toBe("/")
    expect(seen).toEqual(["/legacy/users"])
  })

  test("typed routes win over a mount, and the longest mount prefix wins", async () => {
    const app = server()
      .mountFetch("/api/*", () => new Response("api"))
      .mountFetch("/api/v2/*", () => new Response("v2"))
      .get("/api/users", () => ({ source: "typed" }))

    expect(await (await app.fetch(new Request("http://test/api/users"))).json()).toEqual({
      source: "typed",
    })
    expect(await (await app.fetch(new Request("http://test/api/v2/things"))).text()).toBe("v2")
    expect(await (await app.fetch(new Request("http://test/api/other"))).text()).toBe("api")
  })

  test("forwards the platform object on edge-style invocation", async () => {
    const waitUntil = (): void => undefined
    const app = server<{ readonly binding: string }>().mountFetch(
      "/legacy/*",
      (_request, platform) =>
        Response.json({
          binding: platform?.env?.binding,
          hasWaitUntil: typeof platform?.waitUntil === "function",
        }),
    )
    const response = await app.fetch(new Request("http://test/legacy/edge"), {
      env: { binding: "ok" },
      waitUntil,
    })
    expect(await response.json()).toEqual({ binding: "ok", hasWaitUntil: true })
  })

  test("bypasses contracts for mounted responses without weakening typed routes", async () => {
    const leaked = { id: "u1", secret: "still-visible" }
    const app = server()
      .use(responseContract("enforce"))
      .mountFetch("/legacy/*", () => Response.json(leaked))
      .get("/typed", { response: t.object({ id: t.string() }) }, () => leaked as never)

    expect(await (await app.fetch(new Request("http://test/legacy/item"))).json()).toEqual(leaked)
    expect((await app.fetch(new Request("http://test/typed"))).status).toBe(500)
  })
})
