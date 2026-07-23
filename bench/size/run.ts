/**
 * Bundle-size benchmark — **deterministic** (no load test, no box noise; bytes are bytes).
 *
 *   bun run bench:size
 *
 * Measures the **server footprint**: a trivial 2-route JSON server per framework (nifra / Hono /
 * Elysia / raw `Bun.serve`) bundled with `Bun.build({ minify: true })` and gzipped — what actually
 * ships in your deploy artifact (the framework's own code, tree-shaken; not the package install size).
 *
 * Honest by construction: identical app shape per row, same minifier, raw + gzip both shown, the raw
 * `Bun.serve` floor included. Versions are whatever's installed (printed below). (Client/hydration
 * payload is a separate axis — see SSR-BENCHMARKS.md's "client JS" column + /docs/frameworks.)
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { gzipSync } from "bun"

const here = dirname(Bun.fileURLToPath(import.meta.url))
const tmp = join(here, ".tmp") // inside bench/ so node_modules (workspace @nifrajs/* + hono/elysia) resolve
const CHECK = process.argv.includes("--check")
mkdirSync(tmp, { recursive: true })

const kb = (n: number): string => `${(n / 1024).toFixed(1)} KB`
const pad = (s: string, n: number): string => s.padEnd(n)

interface Size {
  readonly label: string
  readonly min: number
  readonly gz: number
}

async function measure(
  label: string,
  source: string,
  opts: { target: "bun" | "browser"; external?: string[]; conditions?: string[] },
): Promise<Size | null> {
  const entry = join(tmp, `${label.replace(/[^a-z0-9]/gi, "_")}.tsx`)
  writeFileSync(entry, source)
  let built: Awaited<ReturnType<typeof Bun.build>>
  try {
    built = await Bun.build({
      entrypoints: [entry],
      target: opts.target,
      minify: true,
      ...(opts.external ? { external: opts.external } : {}),
      ...(opts.conditions ? { conditions: opts.conditions } : {}),
    })
  } catch (err) {
    // Unresolvable dep (e.g. an adapter the bench doesn't depend on) → skip the row, don't crash.
    console.error(
      `  ✗ ${label} skipped: ${err instanceof Error ? err.message.split("\n")[0] : err}`,
    )
    return null
  }
  if (!built.success) {
    console.error(`  ✗ ${label} failed:\n${built.logs.map(String).join("\n")}`)
    return null
  }
  let src = ""
  for (const o of built.outputs) src += await o.text()
  return { label, min: src.length, gz: gzipSync(Buffer.from(src)).length }
}

function table(title: string, rows: ReadonlyArray<Size>, baseline?: string): void {
  console.log(`\n## ${title}\n`)
  const top = Math.max(...rows.map((r) => r.gz))
  const base = baseline ? rows.find((r) => r.label === baseline) : undefined
  const labelWidth = Math.max(16, ...rows.map((row) => row.label.length + 2))
  console.log(`  ${pad("", labelWidth)}${pad("minified", 12)}${pad("gzipped", 12)}bar`)
  for (const r of [...rows].sort((a, b) => a.gz - b.gz)) {
    const bar = "█".repeat(Math.round((r.gz / top) * 24))
    const rel = base && base.gz > 0 ? `  ${(r.gz / base.gz).toFixed(1)}× ${baseline}` : ""
    console.log(
      `  ${pad(r.label, labelWidth)}${pad(kb(r.min), 12)}${pad(kb(r.gz), 12)}${bar}${rel}`,
    )
  }
}

// ── 1. Server footprint ───────────────────────────────────────────────────────────────────────
const SERVER: Record<string, string> = {
  "bun-raw": `const routes = { "/": () => Response.json({ hello: "world" }) }
export default { fetch(req: Request) { const u = new URL(req.url); return (routes as Record<string, () => Response>)[u.pathname]?.() ?? new Response("nf", { status: 404 }) } }`,
  nifra: `import { server } from "@nifrajs/core/server"
export default server().get("/", () => ({ hello: "world" })).get("/users/:id", (c) => ({ id: c.params.id }))`,
  hono: `import { Hono } from "hono"
export default new Hono().get("/", (c) => c.json({ hello: "world" })).get("/users/:id", (c) => c.json({ id: c.req.param("id") }))`,
  elysia: `import { Elysia } from "elysia"
export default new Elysia().get("/", () => ({ hello: "world" })).get("/users/:id", ({ params }: { params: { id: string } }) => ({ id: params.id }))`,
}

// Feature rows pin the marginal cost of optional lanes and validator choices. Keep these app shapes
// intentionally tiny and deterministic: the point is to catch accidental runtime reachability, not to
// model a whole production service.
const NIFRA_FEATURES: Record<string, string> = {
  "nifra-bare": SERVER.nifra as string,
  "nifra-idempotency": `import { server } from "@nifrajs/core/server"
import { idempotency } from "@nifrajs/core/idempotency-plugin"
export default server().use(idempotency()).post("/pay", { idempotency: { scope: "request", namespace: "public:pay" } }, () => ({ ok: true }))`,
  "nifra-effect-ledger": `import { server } from "@nifrajs/core/server"
import { effectLedger } from "@nifrajs/core/effect-ledger"
import { useCapability } from "@nifrajs/core/capabilities"
export default server().use(effectLedger({ sink: () => {} })).post("/write", { capabilities: ["db.write"] }, (c) => { useCapability(c, "db.write"); return { ok: true } })`,
  "nifra-sse": `import { server } from "@nifrajs/core/server"
import { streaming } from "@nifrajs/core/sse"
const event = { "~standard": { version: 1, vendor: "bench", validate: (value: unknown) => ({ value }) } } as const
export default server().use(streaming()).sse("/events", { sse: event }, (_c, stream) => stream.close())`,
  "nifra-mcp": `import { server } from "@nifrajs/core/server"
import { mcp } from "@nifrajs/core/mcp"
const input = { "~standard": { version: 1, vendor: "bench", validate: (value: unknown) => ({ value }) } } as const
export default server().use(mcp()).tool("ping", { description: "Ping", input }, () => ({ ok: true }))`,
  "nifra-valibot": `import { server } from "@nifrajs/core/server"
import * as v from "valibot"
const body = v.object({ name: v.string(), age: v.number() })
export default server().post("/users", { body }, (c) => ({ name: c.body.name }))`,
  "nifra-typebox-t": `import { server } from "@nifrajs/core/server"
import { t } from "@nifrajs/schema"
const body = t.object({ name: t.string(), age: t.number() })
export default server().post("/users", { body }, (c) => ({ name: c.body.name }))`,
}

// Gzip ceilings are deliberately just above measured values: enough headroom for minifier noise, tight
// enough that a newly reachable optional subsystem fails CI. Update only with an explained benchmark diff.
const FEATURE_GZIP_BUDGET_KB: Readonly<Record<string, number>> = {
  "nifra-bare": 15.5,
  // Shared effect evidence plus the explicit atomic safe-retry release path adds ~0.2 KB gzip.
  // +0.2 KB across these three: the router's rejected-parameter diagnostic. A `:id.json` pattern used
  // to fail with a bare "invalid parameter", which reads as a typo when the real answer is a grammar
  // rule, so the message now states the rule and the two ways out. Measured cost of the first draft
  // was ~0.3 KB gzip in EVERY bundle; trimming it to the rule itself (no interpolated example path)
  // recovered a third and kept nifra-bare inside its budget. The remainder is accepted deliberately:
  // it buys a five-second fix instead of a trip to the source, and it is paid once at registration.
  "nifra-idempotency": 18.45,
  "nifra-effect-ledger": 17.22,
  "nifra-mcp": 16,
  "nifra-sse": 16.2,
  "nifra-valibot": 16.5,
  "nifra-typebox-t": 46,
}

const main = async (): Promise<void> => {
  console.log(`\nBundle size — Bun.build({ minify: true }) + gzip  (Bun ${Bun.version})`)
  console.log("Deterministic: identical app shape per row, same minifier. Lower is better.")

  const server: Size[] = []
  for (const [label, source] of Object.entries(SERVER)) {
    const s = await measure(label, source, { target: "bun" })
    if (s) server.push(s)
  }
  table("Server bundle — minimal 2-route JSON app (target: bun)", server, "bun-raw")

  const features: Size[] = []
  for (const [label, source] of Object.entries(NIFRA_FEATURES)) {
    const measured = await measure(label, source, { target: "bun" })
    if (measured) features.push(measured)
  }
  table("Nifra feature matrix — marginal runtime reachability", features, "nifra-bare")

  const budgetFailures = features.flatMap((row) => {
    const budgetKb = FEATURE_GZIP_BUDGET_KB[row.label]
    if (budgetKb === undefined || row.gz <= budgetKb * 1024) return []
    return [
      `${row.label}: ${kb(row.gz)} (${row.gz} B) exceeds ${budgetKb.toFixed(1)} KB gzip budget`,
    ]
  })
  if (budgetFailures.length > 0) {
    throw new Error(`Bundle size budget failed:\n  ${budgetFailures.join("\n  ")}`)
  }

  console.log("\nRows are each framework's own bundled code (tree-shaken) on top of the runtime's")
  console.log("native HTTP — what ships in your server artifact, not the package install size.")

  // Push the gzipped numbers to the website's single source of truth (site-bench.ts's doc says
  // bench:size owns the `bundle` slice — bun-raw is a floor, not a framework row, so it's skipped).
  const SITE_LABELS: Record<string, string> = { nifra: "Nifra", hono: "Hono", elysia: "Elysia" }
  const bundle = server
    .filter((s) => s.label in SITE_LABELS)
    .map((s) => ({
      name: SITE_LABELS[s.label] as string,
      kb: Math.round((s.gz / 1024) * 10) / 10,
      ...(s.label === "nifra" ? { you: true as const } : {}),
    }))
    .sort((a, b) => a.kb - b.kb)
  if (!CHECK && bundle.length === Object.keys(SITE_LABELS).length) {
    const { writeSiteBench } = await import("../site-bench.ts")
    await writeSiteBench({ bundle })
  } else if (bundle.length !== Object.keys(SITE_LABELS).length) {
    console.error("  ! site bundle slice NOT updated — a framework row failed to build")
  }
}

await main().finally(() => rmSync(tmp, { recursive: true, force: true }))
