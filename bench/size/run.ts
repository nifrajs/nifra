/**
 * Bundle-size benchmark - **deterministic** (no load test, no box noise; bytes are bytes).
 *
 *   bun run bench:size
 *
 * Measures the **server footprint**: a trivial 2-route JSON server per framework (nifra / Hono /
 * Elysia / raw `Bun.serve`) bundled with `Bun.build({ minify: true })` and gzipped - what actually
 * ships in your deploy artifact (the framework's own code, tree-shaken; not the package install size).
 *
 * Honest by construction: identical app shape per row, same minifier, raw + gzip both shown, the raw
 * `Bun.serve` floor included. Versions are whatever's installed (printed below). (Client/hydration
 * payload is a separate axis - see SSR-BENCHMARKS.md's "client JS" column + /docs/frameworks.)
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
// +0.4 KB gzip across every row: mixed path segments (`/:key.txt`). The grammar, its per-segment
// matcher, and the trie's ordered mixed-children list all have to ship, so unlike a diagnostic string
// this cost is the feature itself. Two things were measured before accepting it: an app registering
// no mixed segment allocates nothing and pays one `undefined` check on the match path (asserted in
// mixed-segments.test.ts), and removing the now-obsolete rejected-parameter hint - `:id.json` used to
// throw and now compiles - gave 0.2 KB back, so the net is +0.4 rather than +0.6.
// Every row below carries the router, so a router change moves all of them together. The last such
// move was the total specificity comparator that makes the trie router and the browser matcher order
// equally-weighted mixed patterns identically: ~0.2 KB gzip, paid once in `nifra-bare` and inherited.
// The response-contract seam raised every row by ~0.2 KB gzip: the install method, the runtime field,
// the registration-time decision, and the request-path branch. The lane's own logic is NOT in here -
// it lives behind `@nifrajs/core/response-contract` and only arrives when the plugin is installed,
// which is what the budget caught when it was a plain server option (+0.5 KB for everyone).
// The shared same-origin check (`internal/same-origin.ts`, used by both the WebSocket handshake and
// `@nifrajs/web`'s server-function mount) added ~38 B gzip over the host-only comparison it replaced:
// it orders the two schemes so a TLS-terminating proxy stays same-origin while a downgrade does not.
// Measured before and after, and squeezed first - a rank lookup table cost ~50 B because the table is
// a shipped object, so the comparison is written out instead. Only `nifra-mcp` and `nifra-valibot`
// moved a ceiling; both were sitting within 40 B of theirs, which is the gate working as designed.
// The fused query lane (registration-compiled parse+validate+handler closure for query-only
// routes) costs ~0.2 KB gzip in the kernel, so every core-based row moved together.
// The validated POST Web lane is also part of the core registration kernel. Its registration-compiled
// validation + handler continuation (shared by Web and Node-direct) adds ~0.2 KB gzip across the
// matrix; the bounded parser and framing checks remain shared with the generic lane, so this is the
// price of making the safe fast path available by default without weakening the trust boundary.
// The portable response tiers moved every core row together by ~5.1 KB gzip: the onResponseHeaders
// hook with its Node-direct header view, the onResponseBody payload tier, the raw-response tier
// with per-app body tagging, the static response-header tier, and the registration-selected
// lifecycle stages all live in the kernel so their dispatch is reachable from any route. The
// middleware that USES the tiers stays out of these rows - this is the price of the seams
// themselves being available by default on every runtime.
// The RFC 9110 HEAD fallback (router resolves HEAD to the GET handler, and the Bun native table
// aliases it) costs a few bytes in the kernel, so every core-based row moved a little. Two were
// sitting within ~15 B of their ceiling and crossed it; the rest still clear.
// The legacy-mount and shutdown seams (`mountFetch` prefix dispatch on the unmatched path plus
// `onStop` hooks settled with a bounded timeout at `stop()`) moved every core row together by
// ~0.6 KB gzip (bare 22.1 -> 22.7 measured against the pre-seam baseline). Matched routes never
// touch the mount table - the dispatch lives in the `!match.found` branch - and the admission gate
// wraps mounts too, so the cost is availability of the seams, not a hot-path tax. Squeezed first:
// the plan compiler's runner adapter table was deleted outright (the compiler now types the kernel
// through an erased structural cast), which gave ~0.1 KB back before repricing.
// Per-route transport body caps moved every core row together by ~1.6 KB gzip (bare 22.9 -> 24.6
// measured): registration-time `bodyLimit` validation (finite/`"unlimited"`+reason, fail-closed),
// and the in-place capped reader shadowing (`capTransportBodyReads`) that bounds direct `c.req`
// body reads on every route without swapping request identity. Attributed with an esbuild metafile
// diff against the pre-cap baseline: server.ts +1.7 KB min (registration + dispatch), body.ts
// +2.0 KB min (the reader shadowing + capped stream), everything else noise - no optional
// subsystem became reachable. The cap is the default-on security boundary, so its dispatch has to
// live in the kernel; the ceilings move once, together.
const FEATURE_GZIP_BUDGET_KB: Readonly<Record<string, number>> = {
  "nifra-bare": 24.7,
  // Shared effect evidence plus the explicit atomic safe-retry release path adds ~0.2 KB gzip.
  "nifra-idempotency": 27.9,
  "nifra-effect-ledger": 26.7,
  "nifra-mcp": 25.0,
  "nifra-sse": 25.4,
  "nifra-valibot": 25.7,
  "nifra-typebox-t": 54.8,
}

const main = async (): Promise<void> => {
  console.log(`\nBundle size - Bun.build({ minify: true }) + gzip  (Bun ${Bun.version})`)
  console.log("Deterministic: identical app shape per row, same minifier. Lower is better.")

  const server: Size[] = []
  for (const [label, source] of Object.entries(SERVER)) {
    const s = await measure(label, source, { target: "bun" })
    if (s) server.push(s)
  }
  table("Server bundle - minimal 2-route JSON app (target: bun)", server, "bun-raw")

  const features: Size[] = []
  for (const [label, source] of Object.entries(NIFRA_FEATURES)) {
    const measured = await measure(label, source, { target: "bun" })
    if (measured) features.push(measured)
  }
  table("Nifra feature matrix - marginal runtime reachability", features, "nifra-bare")

  // Reconcile what was MEASURED against what was DECLARED, before comparing budgets.
  //
  // `measure` returns null on an unresolvable import or a failed build - it logs to stderr and the
  // caller drops the row - and the budget loop below only walks rows that survived. So the events this
  // gate exists to catch were the ones that silenced it: rename or remove a `@nifrajs/core/*` subpath
  // and its row stops building, disappears, and takes its budget with it. Every remaining row passes,
  // the step exits 0, and CI reports a green bundle-size gate having measured nothing at all.
  const dropped = [
    ...Object.keys(SERVER)
      .filter((label) => !server.some((row) => row.label === label))
      .map((label) => `server row "${label}" did not build (see the ✗ line above)`),
    ...Object.keys(NIFRA_FEATURES)
      .filter((label) => !features.some((row) => row.label === label))
      .map((label) => `feature row "${label}" did not build (see the ✗ line above)`),
  ]
  if (dropped.length > 0) {
    throw new Error(
      `Bundle size gate measured fewer rows than it declares:\n  ${dropped.join("\n  ")}\n` +
        "  A row that cannot build is not a pass - it is the gate losing its subject.",
    )
  }

  // The budgets and the feature matrix have to name the same set. A feature with no budget is
  // unguarded (the loop below skips it); a budget with no feature is a rename nobody finished.
  const budgeted = new Set(Object.keys(FEATURE_GZIP_BUDGET_KB))
  const measured = new Set(features.map((row) => row.label))
  const drift = [
    ...[...measured]
      .filter((l) => !budgeted.has(l))
      .map((l) => `feature "${l}" has no gzip budget`),
    ...[...budgeted].filter((l) => !measured.has(l)).map((l) => `budget "${l}" has no feature row`),
  ]
  if (drift.length > 0) {
    throw new Error(`Bundle size budgets drifted from the feature matrix:\n  ${drift.join("\n  ")}`)
  }

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
  console.log("native HTTP - what ships in your server artifact, not the package install size.")

  // Push the gzipped numbers to the website's single source of truth (site-bench.ts's doc says
  // bench:size owns the `bundle` slice - bun-raw is a floor, not a framework row, so it's skipped).
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
    console.error("  ! site bundle slice NOT updated - a framework row failed to build")
  }
}

await main().finally(() => rmSync(tmp, { recursive: true, force: true }))
