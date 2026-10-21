import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

const option = (name, fallback) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const before = await import(
  pathToFileURL(
    resolve(option("before", "bench/profiling/results/pass2-profiles/proto-before.mjs")),
  )
)
const after = await import(
  pathToFileURL(resolve(option("after", "bench/profiling/results/pass2-profiles/proto-after.mjs")))
)
const rounds = Number(option("rounds", "8"))
const count = Number(option("count", "30000"))
if (![rounds, count].every((n) => Number.isSafeInteger(n) && n > 0))
  throw new Error("invalid count")
const items = (n) => ({
  items: Array.from({ length: n }, (_, i) => ({
    title: `task-${i}`,
    done: false,
    priority: i % 5,
    notes: "x".repeat(64),
  })),
})
const cases = {
  scalar: 42,
  flat: { sku: "SKU-1", qty: 2, note: "gift wrap" },
  wide: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`key${i}`, i])),
  "items-88": items(88),
  "items-560": items(560),
  "scalar-array": { values: Array.from({ length: 4096 }, (_, i) => i) },
  nested: { a: [{ b: [{ c: [{ d: 1 }, { d: 2 }] }] }, { b: [{ c: [{ d: 3 }] }] }] },
}
if (process.argv.includes("--extended")) {
  let deep = { leaf: true }
  for (let i = 0; i < 20000; i++) deep = { child: deep }
  cases.deep = deep
  cases["nested-records"] = {
    items: Array.from({ length: 88 }, (_, id) => ({ id, meta: { flags: { active: true } } })),
  }
  cases["mixed-array"] = { values: [{ id: 0 }, ...Array.from({ length: 4096 }, (_, i) => i)] }
}
const results = {}
for (const [name, value] of Object.entries(cases)) {
  const iterations = name === "deep" ? Math.min(count, 1000) : count
  const targets = [
    { name: "before", guard: before.guardParsedValue },
    { name: "after", guard: after.guardParsedValue },
  ]
  const samples = { before: [], after: [] }
  for (const target of targets)
    for (let i = 0; i < Math.min(iterations, 10000); i++) target.guard(value, "reject")
  for (let round = 0; round < rounds; round++)
    for (const target of round % 2 ? [...targets].reverse() : targets) {
      globalThis.gc?.()
      const start = process.hrtime.bigint()
      for (let i = 0; i < iterations; i++) target.guard(value, "reject")
      samples[target.name].push(Number(process.hrtime.bigint() - start) / iterations)
    }
  results[name] = samples
}
console.log(
  JSON.stringify({
    meta: {
      runtime: globalThis.Bun?.version ?? process.version,
      rounds,
      count,
      deepCount: process.argv.includes("--extended") ? Math.min(count, 1000) : undefined,
      scope: "prototype guard on reused parsed clean JSON values; no parsing or network",
    },
    results,
  }),
)
