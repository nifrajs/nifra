import { heapStats } from "bun:jsc"
import { expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import { server, silentLogger } from "../src/index.ts"
import { nodeDirect } from "../src/node-direct.ts"

/**
 * Routes that register the same hooks in the same order share one stage chain per server, so the
 * memory a fused route costs does not grow with its hooks. Sharing must not let one route's handler,
 * schema or hook order leak into another's.
 */

type Rec = Record<string, unknown>

async function answers(app: ReturnType<typeof build>, request: () => Request): Promise<Rec[]> {
  const web = await app.fetch(request())
  const node = await app.resolveNode(request())
  let nodeBody = ""
  if (node.kind === "response") nodeBody = await node.response.text()
  else if (typeof node.body === "string") nodeBody = node.body
  else if (node.body !== null) nodeBody = new TextDecoder().decode(node.body)
  return [JSON.parse(await web.text()), JSON.parse(nodeBody)]
}

function build(trace: string[]) {
  const a = (): undefined => {
    trace.push("a")
    return undefined
  }
  const b = (): undefined => {
    trace.push("b")
    return undefined
  }
  const after = (result: unknown): unknown => {
    trace.push("after")
    return result
  }
  return server({ logger: silentLogger })
    .use(nodeDirect())
    .derive(() => ({ shared: "d" }))
    .beforeHandle(a)
    .afterHandle(after)
    .get("/plain", (c) => ({ route: "plain", shared: c.shared }))
    .get("/query", { query: t.object({ q: t.string() }) }, (c) => ({
      route: "query",
      q: c.query.q,
      shared: c.shared,
    }))
    .post("/body", { body: t.object({ name: t.string() }) }, (c) => ({
      route: "body",
      name: c.body.name,
      shared: c.shared,
    }))
    .beforeHandle(b)
    .get("/two", (c) => ({ route: "two", shared: c.shared }))
}

test("routes with the same hooks keep their own handler, schema and order", async () => {
  const trace: string[] = []
  const app = build(trace)
  const plain = () => new Request("http://x/plain")
  const query = () => new Request("http://x/query?q=7")
  const body = () =>
    new Request("http://x/body", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "ada" }),
    })
  const two = () => new Request("http://x/two")
  for (let round = 0; round < 3; round++) {
    trace.length = 0
    expect(await answers(app, plain)).toEqual([
      { route: "plain", shared: "d" },
      { route: "plain", shared: "d" },
    ])
    expect(await answers(app, query)).toEqual([
      { route: "query", q: "7", shared: "d" },
      { route: "query", q: "7", shared: "d" },
    ])
    expect(await answers(app, body)).toEqual([
      { route: "body", name: "ada", shared: "d" },
      { route: "body", name: "ada", shared: "d" },
    ])
    // Three routes under [a] ... [after], each served twice (Web and Node-direct).
    expect(trace).toEqual(Array(6).fill(["a", "after"]).flat())
    trace.length = 0
    // The route declared after a second before hook runs both, in order, and not the others' chain.
    await answers(app, two)
    expect(trace).toEqual(["a", "b", "after", "a", "b", "after"])
  }
})

test("a merged server and a group keep their own hook chains", async () => {
  const trace: string[] = []
  const hook = (name: string) => (): undefined => {
    trace.push(name)
    return undefined
  }
  const child = server({ logger: silentLogger })
    .beforeHandle(hook("child"))
    .get("/child", () => ({ route: "child" }))
  const app = server({ logger: silentLogger })
    .use(nodeDirect())
    .beforeHandle(hook("parent"))
    .get("/parent", () => ({ route: "parent" }))
    .merge(child)
    .group("/g", (g) => g.beforeHandle(hook("group")).get("/x", () => ({ route: "group" })))
  const send = async (path: string): Promise<unknown> =>
    (await app.fetch(new Request(`http://x${path}`))).json()
  expect(await send("/parent")).toEqual({ route: "parent" })
  expect(trace.splice(0)).toEqual(["parent"])
  expect(await send("/child")).toEqual({ route: "child" })
  expect(trace.splice(0)).toEqual(["child"])
  expect(await send("/g/x")).toEqual({ route: "group" })
  expect(trace.splice(0)).toEqual(["parent", "group"])
  const node = await app.resolveNode(new Request("http://x/g/x"))
  expect(node.kind === "response" ? node.response.status : node.status).toBe(200)
  expect(trace.splice(0)).toEqual(["parent", "group"])
})

test("the same hooks in another order run in that order", async () => {
  const trace: string[] = []
  const hook = (name: string) => (): undefined => {
    trace.push(name)
    return undefined
  }
  const a = hook("a")
  const b = hook("b")
  const ab = server({ logger: silentLogger })
    .beforeHandle(a)
    .beforeHandle(b)
    .get("/ab", () => "ab")
  const ba = server({ logger: silentLogger })
    .beforeHandle(b)
    .beforeHandle(a)
    .get("/ba", () => "ba")
  const app = server({ logger: silentLogger }).merge(ab).merge(ba)
  await app.fetch(new Request("http://x/ab"))
  expect(trace.splice(0)).toEqual(["a", "b"])
  await app.fetch(new Request("http://x/ba"))
  expect(trace.splice(0)).toEqual(["b", "a"])
})

test("routes whose hook sets differ in only one phase do not share a chain", async () => {
  const derive1 = () => ({ tag: "d1" })
  const derive2 = () => ({ tag: "d2" })
  const after1 = (result: unknown): unknown => Object.assign({}, result, { after: 1 })
  const after2 = (result: unknown): unknown => Object.assign({}, result, { after: 2 })
  const one = server({ logger: silentLogger })
    .derive(derive1)
    .afterHandle(after1)
    .get("/one", (c) => ({ tag: c.tag }))
  const otherDerive = server({ logger: silentLogger })
    .derive(derive2)
    .afterHandle(after1)
    .get("/derive", (c) => ({ tag: c.tag }))
  const otherAfter = server({ logger: silentLogger })
    .derive(derive1)
    .afterHandle(after2)
    .get("/after", (c) => ({ tag: c.tag }))
  const app = server({ logger: silentLogger }).merge(one).merge(otherDerive).merge(otherAfter)
  const send = async (path: string): Promise<unknown> =>
    (await app.fetch(new Request(`http://x${path}`))).json()
  expect(await send("/one")).toEqual({ tag: "d1", after: 1 })
  expect(await send("/derive")).toEqual({ tag: "d2", after: 1 })
  expect(await send("/after")).toEqual({ tag: "d1", after: 2 })
})

test("two servers sharing a hook function keep their own response hooks", async () => {
  const hook = (): undefined => undefined
  const plain = server({ logger: silentLogger })
    .beforeHandle(hook)
    .get("/x", () => "x")
  const stamped = server({ logger: silentLogger })
    .beforeHandle(hook)
    .onResponse((response) => {
      response.headers.set("x-stamped", "yes")
      return response
    })
    .get("/x", () => "x")
  expect((await plain.fetch(new Request("http://x/x"))).headers.get("x-stamped")).toBeNull()
  expect((await stamped.fetch(new Request("http://x/x"))).headers.get("x-stamped")).toBe("yes")
  expect((await plain.fetch(new Request("http://x/x"))).headers.get("x-stamped")).toBeNull()
})

/** Function objects the heap holds after `count` routes beyond a first one, per route. */
function functionsPerRoute(count: number, hooked: boolean): number {
  const measure = (): number => {
    Bun.gc(true)
    Bun.gc(true)
    return heapStats().objectTypeCounts.Function ?? 0
  }
  const hooks = (app: ReturnType<typeof server>): ReturnType<typeof server> =>
    hooked
      ? app
          .derive(() => ({}))
          .derive(() => ({}))
          .beforeHandle(() => undefined)
          .beforeHandle(() => undefined)
          .afterHandle((result: unknown) => result)
      : app
  const app = hooks(server({ logger: silentLogger }))
  app.get("/first", () => "first")
  const before = measure()
  const handlers = Array.from({ length: count }, (_, i) => () => `route ${i}`)
  for (const [i, handler] of handlers.entries()) app.get(`/r${i}/:id`, handler)
  const after = measure()
  expect(handlers).toHaveLength(count)
  return (after - before) / count
}

test("a fused hook route costs a fixed handful of functions, not a chain of its own", () => {
  const bare = functionsPerRoute(1000, false)
  const hooked = functionsPerRoute(1000, true)
  // A route's own entry closures; every stage closure is shared with the routes before it.
  expect(hooked - bare).toBeLessThanOrEqual(4)
})
