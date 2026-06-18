// Schema validation overhead benchmark — runs on Node (V8) and Bun (JSC): `node bench/schema/validate-overhead.mjs`
//
// Question: is an opt-in "fast-path" (core calls a t-schema's compiled checker directly, skipping the
// Standard Schema wrapper) worth building? This measures the steady-state per-request cost of:
//   A  — current path: validateStandard(nifraSchema, value)  [Standard Schema wrapper + outcome normalize]
//   B1 — fast-path:    compiled.Check(value) then build {ok,value}  [realistic: still returns an outcome]
//   B2 — floor:        compiled.Check(value) only               [theoretical max if core uses value inline]
// plus first-hit compile latency and the interpreted (edge-safe, no-eval) alternative.

import { Type } from "@sinclair/typebox"
import { TypeCompiler } from "@sinclair/typebox/compiler"
import { Value } from "@sinclair/typebox/value"

// ── Faithful copies of nifra's shipped wrapper code (packages/schema/src/adapter.ts) ──
function fromTypeBox(schema) {
  let compiled
  return {
    "~standard": {
      version: 1,
      vendor: "nifra",
      validate: (value) => {
        compiled ??= TypeCompiler.Compile(schema)
        if (compiled.Check(value)) return { value }
        const issues = [...compiled.Errors(value)].map((e) => ({
          message: e.message,
          path: e.path === "" ? undefined : e.path.slice(1).split("/"),
        }))
        return { issues }
      },
      types: undefined,
    },
    jsonSchema: schema,
  }
}
// packages/core/src/schema/standard.ts
function normalize(result) {
  if (result.issues !== undefined) return { ok: false, issues: result.issues }
  return { ok: true, value: result.value }
}
function validateStandard(schema, value) {
  const result = schema["~standard"].validate(value)
  return result instanceof Promise ? result.then(normalize) : normalize(result)
}

// ── Representative schemas + valid inputs ──
const S = Type.Object({ id: Type.String(), q: Type.String() })
const sVal = { id: "abc123", q: "search terms" }

const M = Type.Object({
  name: Type.String(),
  email: Type.String(),
  age: Type.Integer(),
  active: Type.Boolean(),
  nickname: Type.Optional(Type.String()),
})
const mVal = { name: "Ada Lovelace", email: "ada@example.com", age: 36, active: true }

const L = Type.Object({
  orderId: Type.String(),
  customer: Type.Object({ id: Type.String(), name: Type.String(), tier: Type.String() }),
  items: Type.Array(Type.Object({ sku: Type.String(), qty: Type.Integer(), price: Type.Number() })),
  notes: Type.Optional(Type.String()),
})
const lVal = {
  orderId: "ord_001",
  customer: { id: "c1", name: "Grace Hopper", tier: "gold" },
  items: Array.from({ length: 10 }, (_, i) => ({ sku: `sku-${i}`, qty: i + 1, price: 9.99 + i })),
}

// ── Harness: warmup + best-of-N median. Results are stored to a module-level holder so V8/JSC escape
// analysis cannot scalar-replace the allocated outcome objects — in a real server the validated value
// escapes into ctx.query and the handler, so we must measure the allocations, not let the JIT elide them.
const HOLDER = { ref: null }
function bench(fn, iters, trials = 7) {
  for (let i = 0; i < 50_000; i++) HOLDER.ref = fn()
  const times = []
  for (let t = 0; t < trials; t++) {
    const t0 = process.hrtime.bigint()
    for (let i = 0; i < iters; i++) HOLDER.ref = fn()
    times.push(Number(process.hrtime.bigint() - t0) / iters)
  }
  times.sort((a, b) => a - b)
  return times[Math.floor(times.length / 2)]
}

const cases = [
  { name: "S small (2 str)", schema: S, val: sVal },
  { name: "M medium (5 fld)", schema: M, val: mVal },
  { name: "L large (nested+arr)", schema: L, val: lVal },
]
const ITERS = 1_000_000

const engine = typeof Bun !== "undefined" ? "Bun (JSC)" : `Node ${process.version} (V8)`
console.log(
  `${engine} · TypeBox 0.34.49 · median ns/op, ${ITERS.toLocaleString()} iters × 7 trials\n`,
)
console.log(
  "schema".padEnd(22) +
    "A current".padStart(11) +
    "B1 fast".padStart(10) +
    "B2 floor".padStart(10) +
    "A→B1".padStart(8) +
    "A→B2".padStart(8),
)
for (const c of cases) {
  const nifra = fromTypeBox(c.schema)
  nifra["~standard"].validate(c.val) // prime lazy compile
  const compiled = TypeCompiler.Compile(c.schema)
  // All three return an escaping value so the outcome-object allocations are real (not JIT-elided).
  const A = bench(() => validateStandard(nifra, c.val), ITERS) // → {ok,value} (+ wrapper's intermediate {value})
  const B1 = bench(
    () => (compiled.Check(c.val) ? { ok: true, value: c.val } : { ok: false }),
    ITERS,
  )
  const B2 = bench(() => (compiled.Check(c.val) ? c.val : null), ITERS) // floor: no outcome object
  console.log(
    c.name.padEnd(22) +
      `${A.toFixed(1)}ns`.padStart(11) +
      `${B1.toFixed(1)}ns`.padStart(10) +
      `${B2.toFixed(1)}ns`.padStart(10) +
      (((A - B1) / A) * 100).toFixed(0).padStart(7) +
      "%" +
      (((A - B2) / A) * 100).toFixed(0).padStart(7) +
      "%",
  )
}

console.log(
  "\nFirst-hit lazy compile (TypeCompiler.Compile, one-time per route, uses new Function):",
)
for (const c of cases) {
  const t0 = process.hrtime.bigint()
  TypeCompiler.Compile(c.schema)
  console.log(`  ${c.name.padEnd(22)}${(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(3)} ms`)
}

console.log(
  "\nEdge-safe alt — interpreted Value.Check (no new Function) vs compiled, steady-state:",
)
for (const c of cases) {
  const interp = bench(() => Value.Check(c.schema, c.val), ITERS)
  const compiled = TypeCompiler.Compile(c.schema)
  const comp = bench(() => compiled.Check(c.val), ITERS)
  console.log(
    "  " +
      c.name.padEnd(22) +
      `interp ${interp.toFixed(1)}ns`.padStart(18) +
      `compiled ${comp.toFixed(1)}ns`.padStart(20) +
      `  ${(interp / comp).toFixed(1)}x slower`.padStart(14),
  )
}

if (HOLDER.ref === Symbol()) console.log("unreachable") // keep HOLDER live
