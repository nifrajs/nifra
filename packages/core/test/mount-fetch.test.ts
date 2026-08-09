import { describe, expect, test } from "bun:test"
import { t } from "../../schema/src/index.ts"
import { server } from "../src/index.ts"
import { responseContract } from "../src/server/response-contract-lane.ts"

describe("mountFetch", () => {
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
