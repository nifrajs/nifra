import { expect, test } from "bun:test"
import { server, toFetchHandler } from "@nifrajs/core"

test("app.fetch threads platform env + waitUntil into the handler context", async () => {
  const work = Promise.resolve("bg")
  let captured: Promise<unknown> | undefined
  const app = server().get("/", (c) => {
    c.waitUntil(work)
    return { env: c.env, waitUntilType: typeof c.waitUntil }
  })
  const res = await app.fetch(new Request("http://x/"), {
    env: { KV: "binding" },
    waitUntil: (p) => {
      captured = p
    },
  })
  expect(await res.json()).toEqual({ env: { KV: "binding" }, waitUntilType: "function" })
  expect(captured).toBe(work) // the platform's waitUntil received the scheduled promise
})

test("off-edge (one-arg fetch): c.env is undefined; waitUntil runs the work + swallows rejection", async () => {
  const ran: string[] = []
  const app = server().get("/", (c) => {
    c.waitUntil(Promise.resolve().then(() => ran.push("ok")))
    c.waitUntil(Promise.reject(new Error("boom"))) // must not become an unhandled rejection
    return { env: c.env ?? null }
  })
  const res = await app.fetch(new Request("http://x/")) // no platform
  expect(await res.json()).toEqual({ env: null })
  await Promise.resolve()
  await Promise.resolve()
  expect(ran).toEqual(["ok"]) // background work still ran off-edge
})

test("toFetchHandler adapts a nifra app to the edge fetch(request, env, ctx) shape", async () => {
  const app = server().get("/", (c) => ({ env: c.env }))
  const handler = toFetchHandler(app)
  const res = await handler.fetch(
    new Request("http://x/"),
    { SECRET: "s" },
    { waitUntil: () => {} },
  )
  expect(await res.json()).toEqual({ env: { SECRET: "s" } }) // env reaches c.env
})

test("toFetchHandler routes c.waitUntil to the execution context", async () => {
  const work = Promise.resolve()
  const app = server().get("/", (c) => {
    c.waitUntil(work)
    return { ok: true }
  })
  let waited: Promise<unknown> | undefined
  await toFetchHandler(app).fetch(
    new Request("http://x/"),
    {},
    {
      waitUntil: (p) => {
        waited = p
      },
    },
  )
  expect(waited).toBe(work) // c.waitUntil(work) → ctx.waitUntil(work)
})
