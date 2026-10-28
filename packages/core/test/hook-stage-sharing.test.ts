import { heapStats } from "bun:jsc"
import { expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import { type Logger, server, silentLogger } from "../src/index.ts"
import { nodeDirect } from "../src/node-direct.ts"

/**
 * Routes that register the same hooks in the same order share one stage chain per server, so the
 * memory a fused route costs does not grow with its hooks. Sharing must not let one route's handler,
 * schema or hook order leak into another's.
 */

type Rec = Record<string, unknown>

type Answerable = Pick<ReturnType<typeof build>, "fetch" | "resolveNode">

async function answers(app: Answerable, request: () => Request): Promise<Rec[]> {
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

test("routes with different hook functions of one shape share a chain and keep their own hooks", async () => {
  const trace: string[] = []
  const child = (name: string) =>
    server({ logger: silentLogger })
      .derive(() => ({ who: name }))
      .beforeHandle((): undefined => {
        trace.push(`before ${name}`)
        return undefined
      })
      .afterHandle((result: unknown): unknown => Object.assign({}, result, { after: name }))
      .get(`/${name}`, (c) => ({ route: name, who: c.who }))
  const app = server({ logger: silentLogger })
    .use(nodeDirect())
    .merge(child("a"))
    .merge(child("b"))
    .merge(child("c"))
  for (const name of ["a", "b", "c", "b", "a"]) {
    trace.length = 0
    const answer = { route: name, who: name, after: name }
    expect(await answers(app, () => new Request(`http://x/${name}`))).toEqual([answer, answer])
    // Once on the Web lane and once on Node-direct, and never another route's hook.
    expect(trace).toEqual([`before ${name}`, `before ${name}`])
  }
})

/** The fluent methods the every-shape test drives, viewed structurally so one variable holds the chain. */
interface Chain {
  derive(hook: () => unknown): Chain
  beforeHandle(hook: () => unknown): Chain
  afterHandle(hook: (result: unknown) => unknown): Chain
  get(path: string, handler: (context: Rec) => unknown): Chain
  merge(other: unknown): Chain
  use(plugin: unknown): Chain
  fetch(request: Request): Promise<Response>
  resolveNode(request: Request): ReturnType<ReturnType<typeof build>["resolveNode"]>
}

test("routes of every shape in one server each run exactly their own hooks", async () => {
  const trace: string[] = []
  const counts = [0, 1, 2, 3] as const
  // biome-ignore lint/plugin/noChainedTypeAssertions: the real builder's types are per-route, and this test only needs the methods listed on Chain
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: every method Chain names exists on the builder with these argument shapes
  const fresh = (): Chain => server({ logger: silentLogger }) as unknown as Chain
  let app = fresh().use(nodeDirect())
  const expected = new Map<string, { body: Rec; trace: string[] }>()
  for (const derives of counts) {
    for (const befores of counts) {
      for (const afters of counts) {
        if (derives + befores + afters === 0) continue
        const name = `d${derives}b${befores}a${afters}`
        const steps: string[] = []
        const body: Rec = { route: name }
        let child = fresh()
        for (let k = 0; k < derives; k++) {
          child = child.derive(() => {
            trace.push(`${name} derive ${k}`)
            return { [`d${k}`]: name }
          })
          steps.push(`${name} derive ${k}`)
          body[`d${k}`] = name
        }
        for (let k = 0; k < befores; k++) {
          child = child.beforeHandle((): undefined => {
            trace.push(`${name} before ${k}`)
            return undefined
          })
          steps.push(`${name} before ${k}`)
        }
        for (let k = 0; k < afters; k++) {
          child = child.afterHandle((result: unknown) => {
            trace.push(`${name} after ${k}`)
            return Object.assign({}, result, { [`a${k}`]: name })
          })
          steps.push(`${name} after ${k}`)
          body[`a${k}`] = name
        }
        child = child.get(`/${name}`, (c) => {
          const answer: Rec = { route: name }
          for (let k = 0; k < derives; k++) answer[`d${k}`] = c[`d${k}`]
          return answer
        })
        expected.set(name, { body, trace: steps })
        app = app.merge(child)
      }
    }
  }
  expect(expected.size).toBe(63)
  const names = [...expected.keys()]
  // Forward, backward and strided passes, so a shared chain is entered from every route in turn.
  const order = [...names, ...[...names].reverse(), ...names.filter((_, i) => i % 3 === 0)]
  for (const name of order) {
    trace.length = 0
    const want = expected.get(name)
    const request = (): Request => new Request(`http://x/${name}`)
    const web = await app.fetch(request())
    const node = await app.resolveNode(request())
    let nodeBody = ""
    if (node.kind === "response") nodeBody = await node.response.text()
    else if (typeof node.body === "string") nodeBody = node.body
    else if (node.body !== null) nodeBody = new TextDecoder().decode(node.body)
    expect(JSON.parse(await web.text())).toEqual(want?.body)
    expect(JSON.parse(nodeBody)).toEqual(want?.body)
    // Once on the Web lane and once on Node-direct, in registration order, and no other route's hook.
    expect(trace).toEqual([...(want?.trace ?? []), ...(want?.trace ?? [])])
  }
})

test("servers with one hook shape each log a thrown hook to their own logger and policy", async () => {
  const hook = (): undefined => {
    throw new Error("hook failed")
  }
  const logs: string[] = []
  const logger = (name: string): Logger => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: (_message, fields) => logs.push(`${name} ${JSON.stringify(fields?.detail ?? null)}`),
  })
  const make = (name: string, errorLogDetail: "full" | "none") =>
    server({ logger: logger(name), errorLogDetail })
      .use(nodeDirect())
      .beforeHandle(hook)
      .get("/x", () => "x")
  const quiet = make("quiet", "none")
  const loud = make("loud", "full")
  for (const app of [quiet, loud, quiet]) {
    expect((await app.fetch(new Request("http://x/x"))).status).toBe(500)
    const node = await app.resolveNode(new Request("http://x/x"))
    expect(node.kind === "response" ? node.response.status : node.status).toBe(500)
  }
  // The policy and sink belong to the server that handled the request, not to the first one to build the shape.
  expect(logs).toEqual([
    "quiet null",
    "quiet null",
    'loud "hook failed"',
    'loud "hook failed"',
    "quiet null",
    "quiet null",
  ])
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

/** Function objects the heap holds per route when every route has before hooks no other route has. */
function functionsPerRouteWithOwnHooks(count: number, hooked: boolean): number {
  const measure = (): number => {
    Bun.gc(true)
    Bun.gc(true)
    return heapStats().objectTypeCounts.Function ?? 0
  }
  const app = server({ logger: silentLogger }).use(nodeDirect())
  app.get("/first", () => "first")
  const before = measure()
  for (let i = 0; i < count; i++) {
    // Each route runs the hooks registered before it, so no two routes run the same ones.
    if (hooked) app.beforeHandle(() => undefined)
    app.get(`/r${i}`, () => `route ${i}`)
  }
  const after = measure()
  expect(app).toBeDefined()
  return (after - before) / count
}

test("a fused hook route costs a fixed handful of functions even when no two routes share a hook", () => {
  const bare = functionsPerRouteWithOwnHooks(1000, false)
  const hooked = functionsPerRouteWithOwnHooks(1000, true)
  // The hook registered for the route is its own; the Web and Node-direct entry closures are the rest.
  expect(hooked - bare).toBeLessThanOrEqual(1 + 2)
})

test("fused hook routes get their own signal per request under a request timeout", async () => {
  const signals: AbortSignal[] = []
  const hooked = server({ logger: silentLogger, requestTimeoutMs: 60_000 })
    .derive(() => ({ user: "u" }))
    .beforeHandle(() => undefined)
    .afterHandle((result) => result)
    .get("/bound", (c) => {
      signals.push(c.signal)
      return { user: c.user }
    })
  const shared = server({ logger: silentLogger, requestTimeoutMs: 60_000 })
    .derive(() => ({ user: "u" }))
    .derive(() => ({ team: "t" }))
    .beforeHandle(() => undefined)
    .get("/shared", (c) => {
      signals.push(c.signal)
      return { user: c.user, team: c.team }
    })
  for (const [app, path] of [
    [hooked, "/bound"],
    [shared, "/shared"],
  ] as const) {
    signals.length = 0
    for (let i = 0; i < 2; i++) {
      const response = await app.fetch(new Request(`http://x${path}`))
      expect(response.status).toBe(200)
    }
    expect(signals).toHaveLength(2)
    expect(signals[0]).not.toBe(signals[1])
    expect(signals[0]?.aborted).toBe(false)
  }
})
