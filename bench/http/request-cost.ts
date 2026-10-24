/** Produce-side request costs, not socket throughput. Optional BASELINE_CORE points at a core src copy.
 * Run: bun bench/http/request-cost.ts; BASELINE_CORE=/absolute/core/src bun bench/http/request-cost.ts
 * Alternates before/after order each round; checks wire output outside the timed loops.
 */

import { Elysia, t as et } from "elysia"
import { Router } from "../../packages/core/src/router/router.ts"
import { pathnameOf, urlPartsOf } from "../../packages/core/src/server/http.ts"
import { queryObjectOf } from "../../packages/core/src/server/query.ts"
import { fusedRespondNoSet, toResponse } from "../../packages/core/src/server/respond.ts"
import { EMPTY_RESPONSE_CONTROLS } from "../../packages/core/src/server/runtime-core.ts"
import { server } from "../../packages/core/src/server.ts"
import { t } from "../../packages/schema/src/index.ts"

const iterations = Number(process.env.BENCH_MICRO_N ?? 100_000)
const rounds = Number(process.env.BENCH_MICRO_ROUNDS ?? 9)
if (
  !Number.isSafeInteger(iterations) ||
  iterations < 1 ||
  !Number.isSafeInteger(rounds) ||
  rounds < 3
)
  throw new Error("BENCH_MICRO_N must be positive; BENCH_MICRO_ROUNDS must be >= 3")
const baseline = process.env.BASELINE_CORE
// The baseline must be an unchanged source copy of this core version (not an arbitrary module).
const before: typeof server | undefined = baseline
  ? (await import(`${baseline}/server.ts`)).server
  : undefined
const query = t.object({ q: t.string(), limit: t.string() })
const body = t.object({ name: t.string(), age: t.number() })
const headers = { "content-type": "application/json" }
const payload = JSON.stringify({ name: "Ada", age: 36 })
function app(factory: typeof server, general: boolean) {
  const a = factory()
  // afterHandle selects the full route program instead of a fused before-only lane.
  if (general) a.afterHandle((value) => value)
  return a
    .get("/", () => ({ hello: "world" }))
    .get("/users/:id", (c) => ({ id: c.params.id }))
    .get("/search", { query }, (c) => ({ q: c.query.q, limit: c.query.limit }))
    .post("/users", { body }, (c) => ({ name: c.body.name, age: c.body.age }))
    .put("/users/:id", { body }, (c) => ({ id: c.params.id, name: c.body.name }))
}
const competitor = new Elysia()
  .get("/", () => ({ hello: "world" }))
  .get("/users/:id", (c) => ({ id: c.params.id }))
  .get("/search", (c) => ({ q: c.query.q, limit: c.query.limit }), {
    query: et.Object({ q: et.String(), limit: et.String() }),
  })
  .post("/users", (c) => ({ name: c.body.name, age: c.body.age }), {
    body: et.Object({ name: et.String(), age: et.Number() }),
  })
  .put("/users/:id", (c) => ({ id: c.params.id, name: c.body.name }), {
    body: et.Object({ name: et.String(), age: et.Number() }),
  })
  .compile()
const cases = [
  { name: "GET static", make: (_i: number) => new Request("http://localhost/") },
  { name: "GET id repeated", make: (_i: number) => new Request("http://localhost/users/123") },
  { name: "GET id varied", make: (i: number) => new Request(`http://localhost/users/${i % 4096}`) },
  {
    name: "GET search",
    make: (_i: number) => new Request("http://localhost/search?q=ada&limit=10"),
  },
  {
    name: "GET encoded",
    make: (_i: number) => new Request("http://localhost/search?q=ada+lovelace&limit=10"),
  },
  {
    name: "POST body",
    make: (_i: number) =>
      new Request("http://localhost/users", { method: "POST", headers, body: payload }),
  },
  {
    name: "PUT id/body",
    make: (_i: number) =>
      new Request("http://localhost/users/123", { method: "PUT", headers, body: payload }),
  },
]
let sink: unknown
function summary(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b)
  return `${sorted[Math.floor(sorted.length / 2)]!.toFixed(0)} [${sorted[0]!.toFixed(0)}..${sorted.at(-1)!.toFixed(0)}]`
}
console.log(
  `Bun ${Bun.version}; ${rounds} alternating rounds × ${iterations}; median [min..max] ns/op; includes Request creation, excludes response drain`,
)
for (const general of [false, true]) {
  const current = app(server, general)
  const old = before ? app(before, general) : undefined
  const targets = [
    ...(old ? [{ name: "before", fetch: (r: Request) => old.fetch(r) }] : []),
    { name: "current", fetch: (r: Request) => current.fetch(r) },
    ...(!general ? [{ name: "elysia", fetch: (r: Request) => competitor.handle(r) }] : []),
  ]
  for (const c of cases) {
    const expected = await (await current.fetch(c.make(0))).text()
    for (const target of targets) {
      const response = await target.fetch(c.make(0))
      const actual = await response.text()
      if (response.status !== 200 || actual !== expected)
        throw new Error(
          `wire mismatch: ${c.name} ${target.name}: ${response.status} ${actual}; expected ${expected}`,
        )
      for (let i = 0; i < 10_000; i++) sink = await target.fetch(c.make(i))
    }
    const samples: number[][] = targets.map(() => [])
    for (let round = 0; round < rounds; round++) {
      const order = round % 2 ? targets.map((_, i) => i).reverse() : targets.map((_, i) => i)
      for (const index of order) {
        const target = targets[index]!
        const start = Bun.nanoseconds()
        for (let i = 0; i < iterations; i++) sink = await target.fetch(c.make(i))
        samples[index]!.push((Bun.nanoseconds() - start) / iterations)
      }
    }
    console.log(
      `${general ? "general" : "fused  "} ${c.name.padEnd(16)} ${targets.map((t, i) => `${t.name} ${summary(samples[i]!)}`).join(" | ")}`,
    )
  }
}
const router = new Router<number>()
router.add("GET", "/users/:id", 1)
const url = "http://localhost:3000/search?q=ada&limit=10"
for (const [name, fn] of [
  ["pathname loop", () => pathnameOf(url)],
  ["url parts", () => urlPartsOf(url)],
  ["query plain", () => queryObjectOf("?q=ada&limit=10")],
  ["query encoded", () => queryObjectOf("?q=ada+lovelace&limit=10")],
  ["router repeated", () => router.find("GET", "/users/123")],
  ["router varied", (i: number) => router.find("GET", `/users/${i % 4096}`)],
  ["render tracked", () => toResponse({ ok: true }, EMPTY_RESPONSE_CONTROLS)],
  ["render unobserved", () => fusedRespondNoSet({ ok: true }, false, undefined, true)],
] as const) {
  for (let i = 0; i < 50_000; i++) sink = fn(i)
  const samples = []
  for (let r = 0; r < rounds; r++) {
    const start = Bun.nanoseconds()
    for (let i = 0; i < iterations * 5; i++) sink = fn(i)
    samples.push((Bun.nanoseconds() - start) / (iterations * 5))
  }
  console.log(`component ${name.padEnd(18)} ${summary(samples)}`)
}
// Observable sink prevents dead-code elimination of helper results.
if (sink === undefined) throw new Error("missing benchmark result")
