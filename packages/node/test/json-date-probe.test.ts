import { afterEach, expect, test } from "bun:test"
import { server, status } from "@nifrajs/core"
import { t } from "@nifrajs/schema"
import { type NodeServer, serve } from "../src/index.ts"

/**
 * The adapter writes a route's answers with that route's Date probe, so a route that keeps answering
 * without a `Date` stops paying for the look.
 */

const SETTLE = 16

let running: NodeServer | undefined
afterEach(async () => {
  await running?.stop({ drainMs: 0 })
  running = undefined
})

type Answer = () => object
const SHAPES: ReadonlyArray<
  readonly [string, "GET" | "POST", (answer: Answer) => ReturnType<typeof server>]
> = [
  ["bare", "GET", (a) => server().get("/r", () => a())],
  [
    "c.set",
    "GET",
    (a) =>
      server().get("/r", (c) => {
        c.set.headers["x-lane"] = "set"
        return a()
      }),
  ],
  ["status()", "GET", (a) => server().get("/r", () => status(201, a()))],
  ["body", "POST", (a) => server().post("/r", { body: t.object({ n: t.number() }) }, () => a())],
  [
    "derive and before",
    "GET",
    (a) =>
      server()
        .derive(() => ({ who: "ada" }))
        .beforeHandle(() => undefined)
        .get("/r", () => a()),
  ],
]

for (const [name, method, build] of SHAPES)
  test(`${name}: answers after ${SETTLE} Date-free ones skip the probe`, async () => {
    // The probe reads the answer's keys once and the serializer once; a skipped answer only the latter.
    let reads = 0
    const handler: ProxyHandler<object> = {
      ownKeys: (target) => {
        reads++
        return Reflect.ownKeys(target)
      },
    }
    running = await serve(
      build(() => new Proxy({ n: 1 }, handler)),
      { hostname: "127.0.0.1", port: 0 },
    )
    const init: RequestInit =
      method === "GET"
        ? {}
        : { method, headers: { "content-type": "application/json" }, body: '{"n":1}' }
    const perAnswer: number[] = []
    for (let i = 0; i <= SETTLE; i++) {
      const before = reads
      const response = await fetch(`http://127.0.0.1:${running.port}/r`, init)
      expect(await response.text()).toBe('{"n":1}')
      perAnswer.push(reads - before)
    }
    expect(perAnswer[SETTLE]).toBe(perAnswer[0]! - 1)
  })
