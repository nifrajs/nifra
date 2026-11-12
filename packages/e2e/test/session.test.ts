import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { cookieJar } from "@nifrajs/testing"
import { fakeEngine } from "../src/fake.ts"
import { type EngineFactory, e2e, expect as e2eExpect } from "../src/index.ts"
import { buildPath, parseCookieHeader } from "../src/session.ts"

const app = server()
  .get("/", () => "home")
  .get("/users/:id", () => "user")
  .get("/orgs/:org/repos/:repo", () => "repo")

const pages = {
  "/": [{ role: "heading", name: "Home", text: "Home" }],
  "/users/7": [{ role: "heading", name: "User 7", text: "User 7" }],
  "/orgs/a%20b/repos/x": [{ role: "heading", name: "Repo", text: "Repo" }],
  "/?tab=1&on=true": [{ role: "heading", name: "Tab", text: "Tab" }],
}

describe("buildPath", () => {
  test("fills params, encodes them, and appends the query", () => {
    expect(buildPath("/users/:id", { id: 7 }, undefined)).toBe("/users/7")
    expect(buildPath("/orgs/:org/repos/:repo", { org: "a b", repo: "x" }, { page: 2 })).toBe(
      "/orgs/a%20b/repos/x?page=2",
    )
    expect(buildPath("/", undefined, {})).toBe("/")
  })

  test("a value no segment can carry is BAD_PATH, and a slash is encoded", () => {
    expect(() => buildPath("/users/:id", { id: ".." }, undefined)).toThrow(
      'route /users/:id cannot carry the value of "id"',
    )
    expect(buildPath("/users/:id", { id: "a/b;c" }, undefined)).toBe("/users/a%2Fb%3Bc")
  })

  test("a missing param is BAD_PATH", () => {
    expect(() => buildPath("/users/:id", {}, undefined)).toThrow(
      'route /users/:id needs the param "id"',
    )
  })
})

describe("parseCookieHeader", () => {
  test("splits pairs and skips malformed parts", () => {
    expect(parseCookieHeader("sid=abc; theme=dark=1; =x; junk;")).toEqual([
      { name: "sid", value: "abc" },
      { name: "theme", value: "dark=1" },
    ])
    expect(parseCookieHeader("")).toEqual([])
  })
})

describe("e2e()", () => {
  test("opens typed routes, fills params and query, and reads the URL", async () => {
    const { factory, log } = fakeEngine({ pages })
    await using t = await e2e(app, { engine: factory })
    await t.open("/")
    await e2eExpect(t.screen.getByRole("heading")).toHaveText("Home")
    await e2eExpect(t).toHaveURL("/")

    await t.open("/users/:id", { params: { id: 7 } })
    await e2eExpect(t.screen.getByRole("heading")).toHaveText("User 7")
    await e2eExpect(t).toHaveURL(`${t.baseUrl}/users/7`)

    await t.open("/orgs/:org/repos/:repo", { params: { org: "a b", repo: "x" } })
    await t.open("/", { query: { tab: 1, on: true } })
    await e2eExpect(t).toHaveURL("/?tab=1&on=true")
    expect(log.filter((entry) => entry.kind === "goto").map((entry) => entry.detail)).toEqual([
      "/",
      "/users/7",
      "/orgs/a%20b/repos/x",
      "/?tab=1&on=true",
    ])
  })

  test("paths and params are checked at compile time", async () => {
    const { factory } = fakeEngine({ pages })
    await using t = await e2e(app, { engine: factory })
    // @ts-expect-error not a route of this app
    await expect(t.open("/missing")).rejects.toThrow()
    // @ts-expect-error a route with :id needs its params
    await expect(t.open("/users/:id")).rejects.toThrow()
    // @ts-expect-error the param is named id, not user
    await expect(t.open("/users/:id", { params: { user: 1 } })).rejects.toThrow()
  })

  test("hands cookies to the engine and the engine init carries the origin", async () => {
    const seen: Parameters<EngineFactory>[0][] = []
    const { factory } = fakeEngine({ pages })
    const jar = cookieJar()
    jar.set("sid", "abc")
    await using t = await e2e(app, {
      engine: async (init) => {
        seen.push(init)
        return factory(init)
      },
      cookies: jar,
      hydration: "off",
    })
    expect(seen).toEqual([
      { baseUrl: t.baseUrl, cookies: [{ name: "sid", value: "abc" }], hydration: "off" },
    ])
  })

  test("defaults: no cookies, auto hydration", async () => {
    const seen: Parameters<EngineFactory>[0][] = []
    const { factory } = fakeEngine({ pages })
    await using _t = await e2e(app, {
      engine: async (init) => {
        seen.push(init)
        return factory(init)
      },
    })
    expect(seen[0]).toMatchObject({ cookies: [], hydration: "auto" })
  })

  test("close stops the server once, even when called twice or through dispose", async () => {
    const { factory } = fakeEngine({ pages })
    const t = await e2e(app, { engine: factory })
    const base = t.baseUrl
    expect((await fetch(`${base}/`)).status).toBe(200)
    await Promise.all([t.close(), t.close()])
    await t[Symbol.asyncDispose]()
    await expect(fetch(`${base}/`)).rejects.toThrow()
  })

  test("a failing engine factory stops the server and rethrows", async () => {
    let base = ""
    await expect(
      e2e(app, {
        engine: async (init) => {
          base = init.baseUrl
          throw new Error("no browser")
        },
      }),
    ).rejects.toThrow("no browser")
    await expect(fetch(`${base}/`)).rejects.toThrow()
  })
})
