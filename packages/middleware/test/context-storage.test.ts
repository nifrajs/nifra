import { describe, expect, test } from "bun:test"
import { type Context, server } from "@nifrajs/core"
import { nodeDirect } from "@nifrajs/core/node-direct"
import { contextStorage, getContext, tryGetContext } from "@nifrajs/middleware/context-storage"

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe("contextStorage()", () => {
  test("getContext throws outside a stored request; tryGetContext returns undefined", () => {
    expect(tryGetContext()).toBeUndefined()
    expect(() => getContext()).toThrow(/no active context/)
  })

  test("stores the current context across async work and applies only to subsequent routes", async () => {
    const app = server()
      .get("/before", () => ({ stored: tryGetContext() !== undefined }))
      .use(contextStorage())
      .use(nodeDirect())
      .get("/users/:id", async () => {
        const before = getContext()
        await Promise.resolve()
        const after = getContext()
        expect(after).toBe(before)
        return { id: after.params.id, path: new URL(after.req.url).pathname }
      })

    expect(await (await app.fetch(new Request("http://x/before"))).json()).toEqual({
      stored: false,
    })
    expect(await (await app.fetch(new Request("http://x/users/42"))).json()).toEqual({
      id: "42",
      path: "/users/42",
    })
  })

  test("isolates concurrent requests", async () => {
    const a = deferred()
    const b = deferred()
    const gates = new Map([
      ["a", a],
      ["b", b],
    ])
    const arrivals: string[] = []
    const app = server()
      .use(contextStorage())
      .use(nodeDirect())
      .get("/wait/:id", async () => {
        const before = getContext<Context<"/wait/:id">>().params.id
        arrivals.push(before)
        await gates.get(before)?.promise
        return { before, after: getContext<Context<"/wait/:id">>().params.id }
      })

    const first = Promise.resolve(app.fetch(new Request("http://x/wait/a"))).then(
      (res) => res.json() as Promise<{ before: string; after: string }>,
    )
    const second = Promise.resolve(app.fetch(new Request("http://x/wait/b"))).then(
      (res) => res.json() as Promise<{ before: string; after: string }>,
    )

    for (let i = 0; i < 20 && arrivals.length < 2; i++) await Bun.sleep(1)
    b.resolve()
    a.resolve()

    expect(await first).toEqual({ before: "a", after: "a" })
    expect(await second).toEqual({ before: "b", after: "b" })
  })

  test("uses the rewritten request when an onRequest hook replaces it", async () => {
    const app = server()
      .onRequest((req) =>
        new URL(req.url).pathname === "/from"
          ? new Request("http://x/to", { headers: req.headers })
          : undefined,
      )
      .use(contextStorage())
      .use(nodeDirect())
      .get("/to", () => ({ path: new URL(getContext().req.url).pathname }))

    expect(await (await app.fetch(new Request("http://x/from"))).json()).toEqual({ path: "/to" })
  })

  test("is available in order-scoped error handlers", async () => {
    const app = server()
      .use(contextStorage())
      .use(nodeDirect())
      .onError(() => ({ id: getContext().params.id }))
      .get("/boom/:id", () => {
        throw new Error("boom")
      })

    expect(await (await app.fetch(new Request("http://x/boom/7"))).json()).toEqual({ id: "7" })
  })

  test("does not force Node direct JSON outcomes through a Web Response", async () => {
    const app = server()
      .use(contextStorage())
      .use(nodeDirect())
      .get("/node/:id", () => ({ id: getContext().params.id }))

    const outcome = await app.resolveNode(new Request("http://x/node/9"))
    expect(outcome.kind).toBe("json")
    if (outcome.kind === "json") expect(outcome.body).toBe('{"id":"9"}')
  })

  test("can type the current context for helper functions", async () => {
    const readUserId = (): string => getContext<Context<"/typed/:id">>().params.id
    const app = server()
      .use(contextStorage())
      .use(nodeDirect())
      .get("/typed/:id", () => ({ id: readUserId() }))

    expect(await (await app.fetch(new Request("http://x/typed/abc"))).json()).toEqual({
      id: "abc",
    })
  })
})
