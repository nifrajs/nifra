/**
 * Validation hot-path microbench. `t` validators are TypeBox-compiled (codegen via
 * `new Function`), so this isolates the per-validate cost on a representative body —
 * the cost every request carrying a body/query schema pays. Phase 6 puts `t` on the
 * hot path, so this is the perf-cadence checkpoint for the phase.
 *
 * NOTE: hand-rolled in-process harness — directionally honest, not publication
 * grade. Rigorous external-tool numbers come in Phase 7/8.
 */
import { t } from "@nifrajs/schema"

const userSchema = t.object({
  id: t.string(),
  name: t.string(),
  age: t.integer(),
  email: t.string({ format: "email" }),
  tags: t.array(t.string()),
})

const valid = { id: "u1", name: "Ada", age: 36, email: "ada@example.com", tags: ["a", "b", "c"] }
const validate = userSchema["~standard"].validate

function opsPerSec(rounds: number, batch: number): number {
  for (let i = 0; i < 5000; i++) validate(valid) // trigger lazy compile + warm the JIT
  const perRoundNs = new Float64Array(rounds)
  for (let r = 0; r < rounds; r++) {
    const start = Bun.nanoseconds()
    for (let i = 0; i < batch; i++) validate(valid)
    perRoundNs[r] = (Bun.nanoseconds() - start) / batch
  }
  perRoundNs.sort()
  const medianNs = perRoundNs[Math.floor(rounds / 2)] ?? 0
  return medianNs > 0 ? 1e9 / medianNs : 0
}

const ops = opsPerSec(21, 50_000)
console.log(`\n  t validator (TypeBox-compiled) — Bun ${Bun.version}\n`)
console.log(`  validate(object, 5 fields)   ${Math.round(ops).toLocaleString().padStart(12)} ops/s`)
console.log(`  per validation               ${(1e9 / ops).toFixed(1).padStart(12)} ns\n`)
