import { describe, expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import { server, status } from "../src/index.ts"
import { nodeDirect } from "../src/node-direct.ts"
import type { StandardSchemaV1 } from "../src/schema/standard.ts"
import { createDateProbe, routeDatesWritten, withDatesWritten } from "../src/server/json-text.ts"
import { responseContract } from "../src/server/response-contract-lane.ts"

/**
 * A route that keeps answering without a `Date` stops paying for the probe that looks for one, and
 * every lane a route can run on hands the writer that route's probe. A skipped answer goes to the
 * serializer as it came, so the JSON written is the same either way.
 */

const AT = new Date("2026-10-27T12:00:00.000Z")
const SETTLE = 16
const SKIPPED = 31

/** Whether the probe looked at `value`: only a look copies a value holding a `Date`. */
const looked = (probe: ReturnType<typeof createDateProbe>): boolean => {
  const value = { at: AT }
  return routeDatesWritten(value, probe) !== value
}

describe("a route's Date probe", () => {
  test("looks at one answer in 32 once 16 in a row held no Date", () => {
    const probe = createDateProbe()
    for (let i = 0; i < SETTLE; i++) routeDatesWritten({ n: i }, probe)
    const looks = Array.from({ length: 2 * (SKIPPED + 1) }, () => looked(probe))
    expect(looks.indexOf(true)).toBe(SKIPPED)
  })

  test("looks at every answer again once one held a Date", () => {
    const probe = createDateProbe()
    for (let i = 0; i < SETTLE; i++) routeDatesWritten({ n: i }, probe)
    for (let i = 0; i < SKIPPED; i++) routeDatesWritten({ n: i }, probe)
    expect(looked(probe)).toBe(true)
    expect(Array.from({ length: SETTLE }, () => looked(probe))).toEqual(
      Array.from({ length: SETTLE }, () => true),
    )
  })

  test("without a probe every answer is looked at", () => {
    for (let i = 0; i < SETTLE; i++) withDatesWritten({ n: i })
    expect(withDatesWritten({ at: AT })).toEqual({ at: AT.toISOString() })
  })

  test("a skipped answer is written as the serializer writes it", () => {
    const probe = createDateProbe()
    for (let i = 0; i < SETTLE; i++) routeDatesWritten({ n: i }, probe)
    const value = { rows: [{ at: AT, n: 1 }] }
    expect(routeDatesWritten(value, probe)).toBe(value)
    expect(JSON.stringify(value)).toBe(JSON.stringify({ rows: [{ at: AT.toISOString(), n: 1 }] }))
  })
})

// A pass-through output schema, so the writer still sees the handler's own answer.
const asIs: StandardSchemaV1 = {
  "~standard": { version: 1, vendor: "test", validate: (value) => ({ value }) },
}

type Answer = () => object
type Shape = {
  readonly name: string
  readonly method: "GET" | "POST"
  readonly app: (base: ReturnType<typeof server>, answer: Answer) => { fetch: unknown }
}

/** One route at `/r` per lane `selectRouteLanes` can pick, and the hooks that move a route off one. */
const SHAPES: readonly Shape[] = [
  { name: "bare, no context", method: "GET", app: (b, a) => b.get("/r", () => a()) },
  { name: "bare", method: "GET", app: (b, a) => b.get("/r", (_c) => a()) },
  {
    name: "query",
    method: "GET",
    app: (b, a) => b.get("/r", { query: t.object({ q: t.optional(t.string()) }) }, () => a()),
  },
  {
    name: "body",
    method: "POST",
    app: (b, a) => b.post("/r", { body: t.object({ n: t.number() }) }, () => a()),
  },
  {
    name: "derive and before",
    method: "GET",
    app: (b, a) =>
      b
        .derive(() => ({ who: "ada" }))
        .beforeHandle(() => undefined)
        .get("/r", () => a()),
  },
  {
    name: "derive, before and after",
    method: "GET",
    app: (b, a) =>
      b
        .derive(() => ({ who: "ada" }))
        .beforeHandle(() => undefined)
        .afterHandle((result) => result)
        .get("/r", () => a()),
  },
  {
    name: "body, derive and before",
    method: "POST",
    app: (b, a) =>
      b
        .derive(() => ({ who: "ada" }))
        .beforeHandle(() => undefined)
        .post("/r", { body: t.object({ n: t.number() }) }, () => a()),
  },
  {
    name: "onError",
    method: "GET",
    app: (b, a) => b.onError(() => undefined).get("/r", () => a()),
  },
  {
    name: "around",
    method: "GET",
    app: (b, a) => b.around((_c, next) => next()).get("/r", () => a()),
  },
  {
    name: "c.set",
    method: "GET",
    app: (b, a) =>
      b.get("/r", (c) => {
        c.set.headers["x-lane"] = "set"
        return a()
      }),
  },
  { name: "status()", method: "GET", app: (b, a) => b.get("/r", () => status(201, a())) },
  {
    name: "response contract",
    method: "GET",
    app: (b, a) => b.use(responseContract("enforce")).get("/r", { response: asIs }, () => a()),
  },
]

const requestFor = (shape: Shape, origin: string): Request =>
  shape.method === "GET"
    ? new Request(`${origin}/r`)
    : new Request(`${origin}/r`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"n":1}',
      })

type Serve = {
  readonly name: string
  readonly base: () => ReturnType<typeof server>
  readonly send: (
    app: { fetch: unknown },
    shape: Shape,
  ) => Promise<{ stop(): void; ask(): Promise<string> }>
}

/** The members of a `server()` app these lanes call; an app has all of them. */
interface Lane {
  fetch(request: Request): Promise<Response> | Response
  resolveNode(request: Request): Promise<{ body?: unknown }>
  listen(port: number, options: object): { port: number; stop(force: boolean): void }
}

function laneOf(app: { fetch: unknown }): Lane {
  // biome-ignore lint/plugin/noChainedTypeAssertions: an app built by server() has every member of Lane
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the app is a server(), which answers fetch, resolveNode and listen
  return app as unknown as Lane
}

const SERVES: readonly Serve[] = [
  {
    name: "fetch",
    base: () => server(),
    send: async (app, shape) => ({
      stop() {},
      ask: async () => (await laneOf(app).fetch(requestFor(shape, "http://test"))).text(),
    }),
  },
  {
    name: "resolveNode",
    base: () => server().use(nodeDirect()),
    send: async (app, shape) => ({
      stop() {},
      ask: async () => {
        const outcome = await laneOf(app).resolveNode(requestFor(shape, "http://test"))
        return String(outcome.body)
      },
    }),
  },
  {
    name: "listen",
    base: () => server(),
    send: async (app, shape) => {
      const instance = laneOf(app).listen(0, { hostname: "127.0.0.1" })
      return {
        stop: () => instance.stop(true),
        ask: async () =>
          (await fetch(requestFor(shape, `http://127.0.0.1:${instance.port}`))).text(),
      }
    },
  },
]

describe("every lane hands the route's probe to the writer", () => {
  for (const serve of SERVES)
    for (const shape of SHAPES)
      test(`${shape.name}, ${serve.name}`, async () => {
        // Each read of the answer's keys is counted: the probe reads them once, the serializer once.
        let reads = 0
        const handler: ProxyHandler<object> = {
          ownKeys: (target) => {
            reads++
            return Reflect.ownKeys(target)
          },
        }
        const app = shape.app(serve.base(), () => new Proxy({ n: 1, s: "x" }, handler))
        const running = await serve.send(app, shape)
        try {
          const perAnswer: number[] = []
          for (let i = 0; i <= SETTLE; i++) {
            const before = reads
            expect(await running.ask()).toContain('"n":1')
            perAnswer.push(reads - before)
          }
          expect(perAnswer[SETTLE]).toBe(perAnswer[0]! - 1)
        } finally {
          running.stop()
        }
      })
})
