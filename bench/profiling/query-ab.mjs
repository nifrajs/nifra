import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

const option = (name, fallback) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const before = await import(
  pathToFileURL(
    resolve(option("before", "bench/profiling/results/pass2-profiles/query-before.mjs")),
  )
)
const after = await import(
  pathToFileURL(resolve(option("after", "bench/profiling/results/pass2-profiles/query-after.mjs")))
)
const count = Number(option("count", "100000"))
const rounds = 8
if (!Number.isSafeInteger(count) || count < 1) throw new Error("invalid count")
const cases = {
  empty: "?",
  short: "?limit=10",
  plain: "?verbose=1&trace=abc123",
  "plain-16": `?${Array.from({ length: 16 }, (_, i) => `key${i}=value${i}`).join("&")}`,
  "long-value": `?verbose=1&trace=${"a".repeat(1024)}`,
  "bare-segments": `?${Array.from({ length: 256 }, () => "a").join("&")}`,
  "plain-special-keys": "?__proto__=data&constructor=safe&tag=a&tag=b&=empty-key",
  encoded: "?verbose=1&trace=a%20b",
  plus: "?a+b=c+d&empty=&bare",
  repeated: "?tag=a%20b&tag=c%20d&tag=%F0%9F%8C%8D",
  malformed: "?%ZZ=%E0%A4%A&x=%&%5f%5fproto%5f%5f=data&constructor=safe",
  "encoded-16": `?${Array.from({ length: 16 }, (_, i) => `key${i}=a%20b`).join("&")}`,
}
const results = {}
for (const [name, value] of Object.entries(cases)) {
  const targets = [
    { name: "before", parse: before.queryObjectOf },
    { name: "after", parse: after.queryObjectOf },
  ]
  const samples = { before: [], after: [] }
  for (const target of targets) for (let i = 0; i < 20000; i++) target.parse(value)
  for (let round = 0; round < rounds; round++)
    for (const target of round % 2 ? [...targets].reverse() : targets) {
      globalThis.gc?.()
      const start = process.hrtime.bigint()
      for (let i = 0; i < count; i++) target.parse(value)
      samples[target.name].push(Number(process.hrtime.bigint() - start) / count)
    }
  results[name] = samples
}
console.log(
  JSON.stringify({
    meta: {
      runtime: globalThis.Bun?.version ?? process.version,
      rounds,
      count,
      scope: "query materialization; repeated input string; no routing or network",
    },
    results,
  }),
)
