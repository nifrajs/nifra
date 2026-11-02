import { t } from "@nifrajs/schema"
import { guardValue, outputGuard } from "../../packages/web/dist/internal/output-guard.js"

const ITEMS = 50
const POOL_SIZE = 32
const ROUNDS = 15
const ITERATIONS = 10_000
const WARMUP = 20_000
const items = Array.from({ length: ITEMS }, (_, index) => ({
  id: index + 1,
  name: `Item ${index + 1}`,
}))
const schema = t.object({
  items: t.array(t.object({ id: t.integer(), name: t.string() })),
})
const contract = {
  label: "the loader of the output-guard benchmark",
  guard: outputGuard(schema, "output-guard benchmark", "loaderOutput"),
  missing: "loaderOutput",
}
const warmupValues = Array.from({ length: POOL_SIZE }, () => ({ items }))
let sink = 0

function makeValues(count) {
  return Array.from({ length: count }, () => ({ items }))
}

function timePerCall(run, values) {
  const start = process.hrtime.bigint()
  for (let index = 0; index < ITERATIONS; index++) {
    const input = values[index]
    const output = run(input)
    sink += output.items.length
  }
  return Number(process.hrtime.bigint() - start) / ITERATIONS / 1_000
}

function guard(input) {
  return guardValue(contract, input)
}

function identity(input) {
  return input
}

for (const run of [guard, identity]) {
  for (let index = 0; index < WARMUP; index++) {
    const output = run(warmupValues[index & (POOL_SIZE - 1)])
    sink += output.items.length
  }
}

const guardSamplesUs = []
const identitySamplesUs = []
const pairedOverheadSamplesUs = []
for (let round = 0; round < ROUNDS; round++) {
  const values = makeValues(ITERATIONS)
  const guardFirst = round % 2 === 0
  const first = timePerCall(guardFirst ? guard : identity, values)
  const second = timePerCall(guardFirst ? identity : guard, values)
  const guardUs = guardFirst ? first : second
  const identityUs = guardFirst ? second : first
  guardSamplesUs.push(guardUs)
  identitySamplesUs.push(identityUs)
  pairedOverheadSamplesUs.push(guardUs - identityUs)
}

console.log(
  JSON.stringify({
    runtime: typeof Bun === "undefined" ? "node" : "bun",
    runtimeVersion: typeof Bun === "undefined" ? process.version : Bun.version,
    rounds: ROUNDS,
    iterationsPerRound: ITERATIONS,
    warmupIterations: WARMUP,
    guardSamplesUs,
    identitySamplesUs,
    pairedOverheadSamplesUs,
    sink,
  }),
)
