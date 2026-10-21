import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

const arg = (key: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback
const before = await import(
  pathToFileURL(resolve(arg("before", "bench/profiling/results/before/fixture-entry.js"))).href
)
const after = await import(
  pathToFileURL(resolve(arg("after", "bench/profiling/results/candidate/fixture-entry.js"))).href
)
const rounds = Number(arg("rounds", "8"))
const count = Number(arg("count", "100000"))
if (![rounds, count].every((n) => Number.isSafeInteger(n) && n > 0))
  throw new Error("invalid sampling count")
type App = { fetch(request: Request): Response | Promise<Response> }
const diagnosticApp = (
  module: typeof before,
  validationOrder: "validate-before-auth" | "auth-before-validation",
  asyncValidation: boolean,
  asyncHandler: boolean,
): App =>
  module.makeWorstNifraApp(true).get(
    "/diagnostic",
    {
      validationOrder,
      query: {
        "~standard": {
          version: 1,
          vendor: "profile",
          validate(input: unknown) {
            const result =
              input !== null &&
              typeof input === "object" &&
              "trace" in input &&
              typeof input.trace === "string"
                ? { value: { trace: input.trace } }
                : { issues: [{ message: "trace required" }] }
            return asyncValidation ? Promise.resolve(result) : result
          },
        },
      },
    },
    (ctx: { query: unknown }) => {
      const result = { query: ctx.query }
      return asyncHandler ? Promise.resolve(result) : result
    },
  )
const auth = {
  authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
  cookie: "theme=dark",
  origin: "https://app.example.com",
  "x-request-id": "bench-1",
}
const body = JSON.stringify({ sku: "SKU-1", qty: 2, note: "gift wrap" })
const cases: {
  name: string
  makeApp: (module: typeof before) => App
  makeRequest: () => Request
  post?: boolean
}[] = [
  ...(
    [
      ["policy-sync-get", "auth-before-validation", false, false],
      ["policy-async-validation-get", "auth-before-validation", true, false],
      ["generic-async-validation-get", "validate-before-auth", true, false],
      ["generic-async-handler-get", "validate-before-auth", false, true],
    ] as const
  ).map(([name, order, asyncValidation, asyncHandler]) => ({
    name,
    makeApp: (module: typeof before) => diagnosticApp(module, order, asyncValidation, asyncHandler),
    makeRequest: () =>
      new Request("http://bench/diagnostic?trace=abc", { headers: { "x-req-id": "bench-1" } }),
  })),
  {
    name: "realworld-get",
    makeApp: (m) => m.makeNifraApp(),
    makeRequest: () => new Request("http://bench/api/orders?limit=10", { headers: auth }),
  },
  {
    name: "realworld-post",
    makeApp: (m) => m.makeNifraApp(),
    makeRequest: () =>
      new Request("http://bench/api/orders", {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body,
      }),
    post: true,
  },
  ...[false, true].flatMap((generic) => [
    {
      name: `${generic ? "generic" : "closed"}-get`,
      makeApp: (m: typeof before) => m.makeWorstNifraApp(generic),
      makeRequest: () =>
        new Request("http://bench/orgs/acme/projects/apollo/tasks/42?verbose=1&trace=abc123", {
          headers: { "x-req-id": "bench-1" },
        }),
    },
    {
      name: `${generic ? "generic" : "closed"}-encoded`,
      makeApp: (m: typeof before) => m.makeWorstNifraApp(generic),
      makeRequest: () =>
        new Request("http://bench/orgs/a%20b/projects/apollo/tasks/42?verbose=1&trace=a%20b", {
          headers: { "x-req-id": "bench-1" },
        }),
    },
    {
      name: `${generic ? "generic" : "closed"}-long-query`,
      makeApp: (m: typeof before) => m.makeWorstNifraApp(generic),
      makeRequest: () =>
        new Request(
          `http://bench/orgs/acme/projects/apollo/tasks/42?verbose=1&trace=${"a".repeat(512)}`,
          { headers: { "x-req-id": "bench-1" } },
        ),
    },
    ...[88, 560].map((items) => {
      const payload = JSON.stringify({
        items: Array.from({ length: items }, (_, i) => ({
          title: `task-${i}`,
          done: i % 2 === 0,
          priority: i % 5,
          notes: "x".repeat(64),
        })),
      })
      return {
        name: `${generic ? "generic" : "closed"}-post-${items}`,
        makeApp: (m: typeof before) => m.makeWorstNifraApp(generic),
        makeRequest: () =>
          new Request("http://bench/orgs/acme/projects/apollo/tasks", {
            method: "POST",
            headers: { "content-type": "application/json", "x-req-id": "bench-1" },
            body: payload,
          }),
        post: true,
      }
    }),
  ]),
]
const selected = arg("cases", "").split(",").filter(Boolean)
if (selected.some((name) => !cases.some((workload) => workload.name === name)))
  throw new Error("unknown case")
const results: Record<string, Record<string, number[]>> = {}
for (const workload of cases.filter(
  (workload) => selected.length === 0 || selected.includes(workload.name),
)) {
  const request = workload.makeRequest()
  const targets = [
    { name: "before", app: workload.makeApp(before) },
    { name: "after", app: workload.makeApp(after) },
  ]
  const n = workload.post ? Math.max(1000, Math.floor(count / 5)) : count
  const samples: Record<string, number[]> = { before: [], after: [] }
  for (const target of targets) {
    for (let i = 0; i < Math.min(n, 20000); i++) {
      const response = await target.app.fetch(workload.post ? workload.makeRequest() : request)
      if (i === 0 && response.status !== 200) throw new Error(`${workload.name}: invalid probe`)
    }
  }
  for (let round = 0; round < rounds; round++) {
    for (const target of round % 2 ? [...targets].reverse() : targets) {
      Bun.gc(true)
      const start = Bun.nanoseconds()
      for (let i = 0; i < n; i++)
        await target.app.fetch(workload.post ? workload.makeRequest() : request)
      samples[target.name]?.push((Bun.nanoseconds() - start) / n)
    }
  }
  results[workload.name] = samples
  const median = (xs: number[]) => {
    const sorted = [...xs].sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2
      ? (sorted[middle] ?? 0)
      : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
  }
  console.error(
    `${workload.name}: before ${median(samples.before ?? []).toFixed(0)} after ${median(samples.after ?? []).toFixed(0)} ns/req`,
  )
}
console.log(JSON.stringify({ meta: { bun: Bun.version, rounds, count }, results }))
