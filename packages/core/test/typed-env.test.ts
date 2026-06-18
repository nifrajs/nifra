import { expect, test } from "bun:test"
import { server, toFetchHandler } from "@nifrajs/core"

/** A sample typed env (Workers-style bindings). */
interface Env {
  readonly KV: { get(key: string): Promise<string | null> }
  readonly TOKEN: string
}

test("server<Env>() types c.env in a handler; the platform env reaches it at runtime", async () => {
  const app = server<Env>().get("/", (c) => {
    // These compile ONLY because c.env is typed `Env` (KV + TOKEN known) — the core assertion.
    return { hasGet: typeof c.env.KV.get, token: c.env.TOKEN }
  })
  const res = await app.fetch(new Request("http://x/"), {
    env: { KV: { get: async () => "v" }, TOKEN: "secret" },
  })
  expect(await res.json()).toEqual({ hasGet: "function", token: "secret" })
})

test("server<Env>() types c.env in middleware (derive reads the bindings)", async () => {
  const app = server<Env>()
    .derive((c) => ({ upper: c.env.TOKEN.toUpperCase() })) // c.env typed inside derive too
    .get("/", (c) => ({ upper: c.upper, kvType: typeof c.env.KV }))
  const res = await app.fetch(new Request("http://x/"), {
    env: { KV: { get: async () => null }, TOKEN: "abc" },
  })
  expect(await res.json()).toEqual({ upper: "ABC", kvType: "object" })
})

test("toFetchHandler types its env argument against the app's Env", async () => {
  const app = server<Env>().get("/", (c) => ({ token: c.env.TOKEN }))
  const res = await toFetchHandler(app).fetch(
    new Request("http://x/"),
    { KV: { get: async () => null }, TOKEN: "t" }, // typed as Env — wrong shape would not compile
    { waitUntil: () => {} },
  )
  expect(await res.json()).toEqual({ token: "t" })
})

test("typed env: reading an undeclared binding is a compile error", async () => {
  const app = server<Env>().get("/", (c) => {
    // @ts-expect-error - NOPE is not a key of Env
    const x = c.env.NOPE
    return { x: x ?? null }
  })
  const res = await app.fetch(new Request("http://x/"), {
    env: { KV: { get: async () => null }, TOKEN: "t" },
  })
  expect(await res.json()).toEqual({ x: null }) // runs fine; the error is purely type-level
})

test("typed env: a wrong platform env shape is a compile error", async () => {
  const app = server<Env>().get("/", () => ({ ok: true }))
  const res = await app.fetch(new Request("http://x/"), {
    // @ts-expect-error - env is missing the required TOKEN
    env: { KV: { get: async () => null } },
  })
  expect(await res.json()).toEqual({ ok: true })
})

test("plain server(): c.env is unknown (not indexable), and fetch accepts any env shape", async () => {
  const app = server().get("/", (c) => {
    // @ts-expect-error - plain server() leaves c.env `unknown` (today's behavior — cast to use)
    void c.env.anything
    return { envType: typeof c.env }
  })
  const res = await app.fetch(new Request("http://x/"), { env: { whatever: true } })
  expect(await res.json()).toEqual({ envType: "object" })
})
