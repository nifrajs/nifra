/**
 * Router benchmarks. The Phase 1 goal is to be in the same class as the
 * Bun-native leaders on route resolution; the v1 target is parity within ~10% of
 * Elysia (whose router is Memoirist). We also include Hono's RegExpRouter as a
 * second reference. HTTP-level throughput vs Elysia/Hono comes with the server
 * in Phase 2 (see bench/http/).
 *
 * NOTE: this is a microbenchmark with a hand-rolled harness — directionally
 * honest, not publication-grade. Treat the ratios, not the absolute ops/s, as
 * the signal.
 */
import { Router } from "@nifrajs/core/server"
import { RegExpRouter } from "hono/router/reg-exp-router"
import { Memoirist } from "memoirist"
import { type BenchResult, bench, formatOps } from "./src/harness.ts"
import { PARAM_REQUEST, ROUTES, STATIC_REQUEST } from "./src/routes.ts"

const nifra = new Router<string>()
const memo = new Memoirist<string>()
const hono = new RegExpRouter<string>()

for (const r of ROUTES) {
  const payload = `${r.method} ${r.path}`
  nifra.add(r.method, r.path, payload)
  memo.add(r.method, r.path, payload)
  hono.add(r.method, r.path, payload)
}

// Hono's RegExpRouter compiles lazily on first match and throws for route shapes
// it can't express (Hono normally falls back to a trie). Probe once so the
// benchmark only includes it when it actually handles this route set.
let honoReady = true
try {
  hono.match(STATIC_REQUEST.method, STATIC_REQUEST.path)
  hono.match(PARAM_REQUEST.method, PARAM_REQUEST.path)
} catch {
  honoReady = false
}

interface Entry {
  readonly name: string
  readonly result: BenchResult
}

function group(title: string, entries: readonly Entry[]): void {
  const fastest = Math.max(...entries.map((e) => e.result.opsPerSec))
  console.log(`\n  ${title}`)
  for (const e of entries) {
    const rel = ((e.result.opsPerSec / fastest) * 100).toFixed(0)
    console.log(
      `    ${e.name.padEnd(10)} ${formatOps(e.result.opsPerSec).padStart(8)} ops/s` +
        `   p50 ${e.result.medianNs.toFixed(1)}ns   ${rel.padStart(3)}% of fastest`,
    )
  }
}

function scenario(title: string, method: string, path: string): void {
  const entries: Entry[] = [
    { name: "nifra", result: bench("nifra", () => nifra.find(method, path)) },
    { name: "memoirist", result: bench("memoirist", () => memo.find(method, path)) },
  ]
  if (honoReady) {
    entries.push({ name: "hono", result: bench("hono", () => hono.match(method, path)) })
  }
  group(title, entries)
}

console.log(`\n  router resolution — Bun ${Bun.version}  (${ROUTES.length} routes)`)
if (!honoReady) console.log("  (hono RegExpRouter skipped: unsupported route shape)")

scenario(`static   "${STATIC_REQUEST.path}"`, STATIC_REQUEST.method, STATIC_REQUEST.path)
scenario(`param    "${PARAM_REQUEST.path}"`, PARAM_REQUEST.method, PARAM_REQUEST.path)
console.log("")
