import { markTrustedBodyFraming } from "../../packages/core/dist/server/body.js"
import { makeWorstNifraApp } from "../http/worst-case/_app.ts"
import { makeWorstElysiaApp } from "../http/worst-case/_elysia-app.ts"

// Producer-side cost only: no network, no Request construction, and no response-body drain.
// Reusing a bodyless GET Request is safe; POST requests must never use this pattern.
const request = new Request(
  "http://bench/orgs/acme/projects/apollo/tasks/42?verbose=1&trace=abc123",
  {
    headers: { "x-req-id": "bench-1" },
  },
)
const option = (key: string) =>
  process.argv.find((arg) => arg.startsWith(`--${key}=`))?.split("=")[1]
const workload = option("workload") ?? "get"
if (!["get", "post-small", "post-large"].includes(workload)) throw new Error("unknown workload")
const post = workload !== "get"
const framed = process.argv.includes("--framed")
const body = JSON.stringify({
  items: Array.from({ length: workload === "post-large" ? 560 : 88 }, (_, i) => ({
    title: `task-${i}`,
    done: i % 2 === 0,
    priority: i % 5,
    notes: "x".repeat(64),
  })),
})
const contentLength = String(new TextEncoder().encode(body).byteLength)
const makeRequest = () => {
  if (!post) return request
  const req = new Request("http://bench/orgs/acme/projects/apollo/tasks", {
    method: "POST",
    headers: {
      "x-req-id": "bench-1",
      "content-type": "application/json",
      "content-length": contentLength,
    },
    body,
  })
  if (framed) markTrustedBodyFraming(req)
  return req
}
const count = Number(option("count") ?? (post ? 10_000 : 100_000))
if (!Number.isSafeInteger(count) || count < 1) throw new Error("--count must be a positive integer")
const target = option("target")
const shape = option("shape")
if (target !== undefined && !["nifra", "elysia"].includes(target)) throw new Error("unknown target")
if (shape !== undefined && !["closed", "generic"].includes(shape)) throw new Error("unknown shape")
const rounds = Number(option("rounds") ?? 8)
if (!Number.isSafeInteger(rounds) || rounds < 1) throw new Error("invalid rounds")
const apps = [
  { name: "nifra-closed", app: makeWorstNifraApp(false) },
  { name: "elysia-closed", app: makeWorstElysiaApp(undefined, false) },
  { name: "nifra-generic", app: makeWorstNifraApp(true) },
  { name: "elysia-generic", app: makeWorstElysiaApp(undefined, true) },
].filter(
  ({ name }) =>
    (target === undefined || name.startsWith(target)) &&
    (shape === undefined || name.endsWith(shape)),
)
const samples = new Map<string, number[]>(apps.map(({ name }) => [name, []]))
for (const { name, app } of apps) {
  const response = await app.fetch(makeRequest())
  if (
    response.status !== 200 ||
    response.headers.get(post ? "x-count" : "x-trace") !==
      (post ? String(workload === "post-large" ? 560 : 88) : "abc123")
  ) {
    throw new Error(`${name}: ${workload} probe failed`)
  }
  await response.text()
  for (let i = 0; i < Math.min(count, 20_000); i++) await app.fetch(makeRequest())
}
for (let round = 0; round < rounds; round++) {
  const start = round % apps.length
  const rotated = [...apps.slice(start), ...apps.slice(0, start)]
  for (const { name, app } of Math.floor(round / apps.length) % 2 ? rotated.reverse() : rotated) {
    Bun.gc(true)
    const begin = Bun.nanoseconds()
    for (let i = 0; i < count; i++) await app.fetch(makeRequest())
    samples.get(name)?.push((Bun.nanoseconds() - begin) / count)
  }
}
console.log(
  JSON.stringify({
    meta: {
      bun: Bun.version,
      count,
      rounds,
      workload,
      framed,
      scope: post
        ? "in-process POST response production; fresh Request included; body not drained"
        : "in-process GET response production; request reused; body not drained",
    },
    results: Object.fromEntries(
      [...samples].map(([name, values]) => [name, { nsPerRequest: values }]),
    ),
  }),
)
