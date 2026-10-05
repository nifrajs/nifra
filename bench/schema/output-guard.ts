/**
 * The data guard's per-request cost: projecting and validating a loader's data through its output
 * schema, against `JSON.stringify` of the same data - the serialization every data response already
 * pays. A ratio of the two, from paired rounds, holds on any machine; an absolute budget would not.
 */
import { t } from "@nifrajs/schema"
import { guardValue, outputGuard } from "../../packages/web/src/internal/output-guard.ts"

const CHECK = process.argv.includes("--check")
const ROUNDS = 41
const PER_ROUND = 2000
/** Guarding clean data may cost at most this many times serializing it. Measured ~1.2-1.4x. */
const MAX_RATIO = 2

const schema = t.object({
  user: t.object({ id: t.string(), name: t.string() }),
  items: t.array(t.object({ id: t.integer(), name: t.string(), tags: t.array(t.string()) })),
})
const contract = {
  label: "the loader of the benchmark route",
  guard: outputGuard(schema, "the benchmark", "loaderOutput"),
  missing: "",
}
const clean = {
  user: { id: "u1", name: "Ada" },
  items: Array.from({ length: 50 }, (_, i) => ({ id: i + 1, name: `Item ${i + 1}`, tags: ["a"] })),
}
const dirty = {
  ...clean,
  user: { ...clean.user, passwordHash: "x" },
  items: clean.items.map((item) => ({ ...item, cost: 1, supplier: "x" })),
}

const median = (values: readonly number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0

const round = (fn: () => unknown): number => {
  const start = Bun.nanoseconds()
  for (let i = 0; i < PER_ROUND; i++) fn()
  return (Bun.nanoseconds() - start) / PER_ROUND
}

const serialize = () => JSON.stringify(clean)
const guardClean = () => guardValue(contract, clean)
const guardDirty = () => guardValue(contract, dirty)
if (guardClean() !== clean) throw new Error("clean data was copied: projection lost copy-on-write")
for (let i = 0; i < 20_000; i++) {
  serialize()
  guardClean()
  guardDirty()
}

const ratios: number[] = []
const serializeNs: number[] = []
const cleanNs: number[] = []
const dirtyNs: number[] = []
for (let r = 0; r < ROUNDS; r++) {
  // Alternate the order so drift on a shared runner lands on both sides equally.
  let serialized: number
  let guarded: number
  if (r % 2 === 0) {
    serialized = round(serialize)
    guarded = round(guardClean)
  } else {
    guarded = round(guardClean)
    serialized = round(serialize)
  }
  serializeNs.push(serialized)
  cleanNs.push(guarded)
  dirtyNs.push(round(guardDirty))
  ratios.push(guarded / serialized)
}

const ratio = median(ratios)
console.log(`\n  output guard - 50 items, Bun ${Bun.version}\n`)
console.log(`  JSON.stringify          ${median(serializeNs).toFixed(0).padStart(6)} ns`)
console.log(`  guard, declared keys    ${median(cleanNs).toFixed(0).padStart(6)} ns`)
console.log(`  guard, dropping keys    ${median(dirtyNs).toFixed(0).padStart(6)} ns`)
console.log(`  guard / stringify       ${ratio.toFixed(2)}x\n`)
if (CHECK) {
  if (!Number.isFinite(ratio) || ratio > MAX_RATIO) {
    throw new Error(`output guard performance gate failed: ${ratio.toFixed(2)}x > ${MAX_RATIO}x`)
  }
  console.log(`output guard performance gate passed (limit ${MAX_RATIO}x JSON.stringify)`)
}
