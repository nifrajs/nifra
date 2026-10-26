/**
 * Bundle-size benchmark - **deterministic** (no load test, no box noise; bytes are bytes).
 *
 *   bun run bench:size
 *   bun run bench:size --attribution
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
import { dirname, join, relative, resolve } from "node:path"
import { gzipSync } from "bun"

const here = dirname(Bun.fileURLToPath(import.meta.url))
const root = resolve(here, "../..")
const tmp = join(here, ".tmp") // inside bench/ so node_modules (workspace @nifrajs/* + hono/elysia) resolve
const CHECK = process.argv.includes("--check")
const ATTRIBUTION = process.argv.includes("--attribution")
mkdirSync(tmp, { recursive: true })

const kb = (n: number): string => `${(n / 1024).toFixed(1)} KB`
const pad = (s: string, n: number): string => s.padEnd(n)

interface Size {
  readonly label: string
  readonly min: number
  readonly gz: number
  readonly inputs?: Readonly<Record<string, number>>
}

interface Metafile {
  readonly outputs: Readonly<
    Record<
      string,
      { readonly inputs?: Readonly<Record<string, { readonly bytesInOutput: number }>> }
    >
  >
}

function displayInput(input: string): string {
  const absolute = input.startsWith("/") ? input : resolve(root, input)
  return relative(root, absolute) || "."
}

async function measure(
  label: string,
  source: string,
  opts: {
    target: "bun" | "browser"
    external?: string[]
    conditions?: string[]
    attribution?: boolean
  },
): Promise<Size | null> {
  const entry = join(tmp, `${label.replace(/[^a-z0-9]/gi, "_")}.tsx`)
  writeFileSync(entry, source)
  let built: Awaited<ReturnType<typeof Bun.build>>
  try {
    built = await Bun.build({
      entrypoints: [entry],
      target: opts.target,
      minify: true,
      // Model a real production bundle: vite/esbuild/webpack/next and `bun build --production` all
      // inject this define, so framework dev-only branches (guarded by `process.env.NODE_ENV`)
      // dead-code-eliminate. Measuring without it over-counts what actually ships.
      define: { "process.env.NODE_ENV": '"production"' },
      ...(opts.attribution ? { metafile: true } : {}),
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
  if (!opts.attribution) return { label, min: src.length, gz: gzipSync(Buffer.from(src)).length }

  const metafile = (built as typeof built & { metafile?: Metafile }).metafile
  if (!metafile)
    throw new Error(`Bundle attribution requested for ${label}, but Bun returned no metafile`)
  const inputs: Record<string, number> = {}
  for (const output of Object.values(metafile.outputs)) {
    for (const [input, info] of Object.entries(output.inputs ?? {})) {
      if (info.bytesInOutput <= 0) continue
      const name = displayInput(input)
      inputs[name] = (inputs[name] ?? 0) + info.bytesInOutput
    }
  }
  return { label, min: src.length, gz: gzipSync(Buffer.from(src)).length, inputs }
}

function attributionTable(rows: ReadonlyArray<Size>): void {
  const labels = rows.map((row) => row.label)
  const inputNames = new Set<string>()
  for (const row of rows) for (const input of Object.keys(row.inputs ?? {})) inputNames.add(input)
  const inputs = [...inputNames].sort((a, b) => {
    const totalA = rows.reduce((sum, row) => sum + (row.inputs?.[a] ?? 0), 0)
    const totalB = rows.reduce((sum, row) => sum + (row.inputs?.[b] ?? 0), 0)
    return totalB - totalA || a.localeCompare(b)
  })
  const inputWidth = Math.max(42, ...inputs.map((input) => input.length + 2))
  const columnWidths = labels.map((label) => Math.max(12, label.length + 2))
  const cell = (value: string, width: number): string => value.padEnd(width)
  console.log("\n## Bundle attribution - minified output bytes by input\n")
  console.log(
    `  ${cell("input", inputWidth)}${labels.map((label, i) => cell(label, columnWidths[i] as number)).join("")}`,
  )
  for (const input of inputs) {
    console.log(
      `  ${cell(input, inputWidth)}${rows.map((row, i) => cell(String(row.inputs?.[input] ?? 0), columnWidths[i] as number)).join("")}`,
    )
  }
  console.log(
    `  ${cell("TOTAL", inputWidth)}${rows.map((row, i) => cell(String(Object.values(row.inputs ?? {}).reduce((sum, bytes) => sum + bytes, 0)), columnWidths[i] as number)).join("")}`,
  )
  console.log(
    "\nInputs are minified bytes attributed by Bun's metafile; shared bytes are not additive across rows.",
  )
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

const ATTRIBUTION_ROWS: Record<string, string> = {
  bare: SERVER.nifra as string,
  "+node": `import { server } from "@nifrajs/core/server"
import { nodeDirect } from "@nifrajs/core/node-direct"
export default server().use(nodeDirect()).get("/", () => ({ hello: "world" })).get("/users/:id", (c) => ({ id: c.params.id }))`,
  "+websocket": `import { server } from "@nifrajs/core/server"
import { websocket } from "@nifrajs/core/ws"
export default server().use(websocket()).get("/", () => ({ hello: "world" })).get("/users/:id", (c) => ({ id: c.params.id })).ws("/chat", { message: (ws, data) => ws.send(data) })`,
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
  // Upload row: `t` from the form subpath, which adds the file constructors, the byte-signature
  // table and the multipart reader on top of the `nifra-typebox-t` row. None of it may become
  // reachable from `nifra-typebox-t` or `nifra-bare`.
  "nifra-typebox-form": `import { server } from "@nifrajs/core/server"
import { t } from "@nifrajs/schema/form"
const body = t.form({ name: t.string(), avatar: t.file({ accept: ["image/png"] }) })
export default server().post("/users", { body }, (c) => ({ name: c.body.name }))`,
  // Leaf-import row, not a server row: pins the marginal cost of reaching for the review leaf.
  // `@nifrajs/agent-review` must stay dependency-minimal and off the request path - it is composed
  // by `nifra review`, never imported by `core`/`client`/`schema`/`web` or any runtime adapter.
  // A budget break here means the leaf gained a runtime dependency or became reachable from the
  // kernel, both of which are regressions, not repricings.
  "nifra-agent-review": `import { composeReviewReport, digestReviewReport } from "@nifrajs/agent-review"
console.log(typeof composeReviewReport, typeof digestReviewReport)`,
  // Browser row, not a server row: everything the generated client entry imports, which is the
  // router store, history and link interception, head updates and form handling. It is the payload a
  // page ships before any framework adapter, so a route-tree or navigation feature that lands in it
  // is paid by every visitor. The whole namespace is kept so the row does not depend on which
  // exports a given app happens to use.
  "nifra-web-client": `import * as client from "@nifrajs/web/client"
console.log(client)`,
  // Browser row: the whole `@nifrajs/i18n` root (formatter, locale registry, negotiation, the locale
  // cookie), which a translated page ships to every visitor. Routing and the detector are subpaths
  // and must stay out of it.
  "nifra-i18n": `import * as i18n from "@nifrajs/i18n"
console.log(i18n)`,
}

/** Rows bundled for the browser. Every other feature row is a server bundle. */
const BROWSER_FEATURES: ReadonlySet<string> = new Set(["nifra-web-client", "nifra-i18n"])

// Each ceiling is the measured gzip size rounded up to the next 0.1 KB, tight enough that a newly
// reachable optional subsystem fails CI. A commit that raises one states the measured cost.
const FEATURE_GZIP_BUDGET_KB: Readonly<Record<string, number>> = {
  // onRequest + onError hook boundaries and the QUERY method: bare 36,411 -> 36,668 B, mcp 36,694 ->
  // 36,934, sse 37,287 -> 37,535 (+214 / +29 / +14 B on bare, Bun 1.4.3).
  // Guards registered after a `beforeHandler` hook still run first, so an idempotency replay waits
  // for every guard: bare 36,746 -> 36,814 B, effect-ledger 38,789 -> 38,833, valibot 37,756 ->
  // 37,801 (Bun 1.4.3); only these three caps are crossed.
  // Bun's prototype-guard cursor stack, selected at load and dead elsewhere: bare 36,811 -> 36,880 B,
  // idempotency 41,247 -> 41,328, effect-ledger 38,832 -> 38,921, mcp 37,065 -> 37,143, sse 37,664 ->
  // 37,756 (Bun 1.4.2); +0.1 KiB on the five caps it crosses.
  // The fixes the runtime differential found (body read failures, the standard multipart parser,
  // ws.close() argument checks and close reports, JSON byte-order marks, unparseable Hosts): bare
  // 36,838 -> 37,308 B, idempotency 41,285 -> 41,752, effect-ledger 38,871 -> 39,355, mcp 37,105 ->
  // 37,581, sse 37,715 -> 38,197, valibot 37,838 -> 38,317, typebox-form 67,023 -> 68,149 (Bun 1.4.3).
  // An HTTP/1.0 request with no Host served as localhost on Bun, its target resolved: bare
  // 37,345 -> 37,422 B, effect-ledger 39,393 -> 39,454, mcp 37,617 -> 37,689, valibot 38,354 ->
  // 38,413, typebox-form 68,184 -> 68,264 (Bun 1.4.3); +0.1 KiB on the five caps it crosses.
  // General-lifecycle JSON with untouched controls and no response hook takes the fused renderer:
  // bare 37,428 -> 37,480 B, idempotency 41,834 -> 41,897, sse 38,296 -> 38,355, typebox-form
  // 68,298 -> 68,347 (Bun 1.4.4); +0.1 KiB on the four caps it crosses.
  // `authenticate()` stages gate the `mount()` and `mountFetch()` handlers registered after them,
  // WebSocket upgrades included: bare 37,480 -> 37,855 B, idempotency 41,920 -> 42,273,
  // effect-ledger 39,524 -> 39,870, sse 38,356 -> 38,743, mcp 37,752 -> 38,122, valibot 38,500 ->
  // 38,853, typebox-form 68,364 -> 68,734 (Bun 1.4.4); each crossed cap takes the next 0.1 KiB step.
  // Preserve mount authentication metadata and make auth refusals terminal: measured 37,907 B
  // bare, 42,328 B idempotency, 68,853 B typebox-form (Bun 1.4.4). Only these three caps cross;
  // each takes the next 0.1 KiB ceiling, including the schema issue-path fix in typebox-form.
  // `onStopping()` hooks and `stop({ delayMs })`, so readiness fails before the drain: bare 37,907 ->
  // 38,018 B, idempotency 42,328 -> 42,427, effect-ledger 39,919 -> 40,029, mcp 38,179 -> 38,290,
  // sse 38,790 -> 38,894, valibot 38,902 -> 38,998, typebox-form 68,853 -> 68,957 (Bun 1.4.4); each
  // crossed cap takes the next 0.1 KiB step.
  // A `bigint` in a JSON answer written as its decimal string, and the registration step a
  // `t.bytes()` response field takes around the handler and the hooks that answer in its place (its
  // base64 walk ships only with `t`): bare 38,018 -> 38,326 B, idempotency 42,427 -> 42,708,
  // effect-ledger 40,029 -> 40,337, sse 38,894 -> 39,179, mcp 38,290 -> 38,593, valibot 38,998 ->
  // 39,288, typebox-t 63,958 -> 65,228, typebox-form 68,957 -> 70,229 (Bun 1.4.4); each crossed cap
  // takes the next 0.1 KiB step.
  // A route's query, headers and cookies schemas swapped at registration for the text form a schema
  // offers: bare 38,326 -> 38,394 B, idempotency 42,708 -> 42,779, effect-ledger 40,337 -> 40,401,
  // sse 39,179 -> 39,251, mcp 38,593 -> 38,657, valibot 39,288 -> 39,361, typebox-t 65,228 -> 65,348,
  // typebox-form 70,229 -> 70,319 (Bun 1.4.4); each crossed cap takes the next 0.1 KiB step.
  // A route that sets a header, cookie or status with no response hook skips the resident-body
  // record: bare 38,394 -> 38,427 B, idempotency 42,779 -> 42,815, effect-ledger 40,401 -> 40,440,
  // sse 39,251 -> 39,282, mcp 38,657 -> 38,694, valibot 39,361 -> 39,399, typebox-t 65,348 ->
  // 65,376, typebox-form 70,319 -> 70,358 (Bun 1.4.4); each crossed cap takes the next 0.1 KiB step.
  // Bun's Host check behind `validateHost`: bare 38,427 -> 38,453 B, idempotency 42,815 -> 42,850,
  // effect-ledger 40,440 -> 40,468, sse 39,282 -> 39,315, mcp 38,694 -> 38,714, valibot 39,399 ->
  // 39,425, typebox-t 65,376 -> 65,416, typebox-form 70,358 -> 70,396 (Bun 1.4.4); each crossed cap
  // takes the next 0.1 KiB step.
  // GET and HEAD slots in Bun's table skip the body-cap wrapper: bare 38,453 -> 38,472 B, idempotency
  // 42,850 -> 42,874, effect-ledger 40,468 -> 40,488, sse 39,315 -> 39,333, mcp 38,714 -> 38,732,
  // valibot 39,425 -> 39,441, typebox-t 65,416 -> 65,436, typebox-form 70,396 -> 70,416 (Bun 1.4.4);
  // only the sse and typebox-t caps are crossed.
  // A plain `Date` in a JSON answer written ahead of the serializer when the first row holds one:
  // bare 38,472 -> 38,862 B, idempotency 43,247 -> 43,629, effect-ledger 40,488 -> 40,892, sse
  // 39,333 -> 39,722, mcp 38,732 -> 39,131, valibot 39,438 -> 39,858, typebox-t 65,436 -> 65,833,
  // typebox-form 70,416 -> 70,797 (Bun 1.4.4); each crossed cap takes the next 0.1 KiB step.
  // That writer reading each getter once, the accessor check and the copy-first walk: bare 38,862 ->
  // 38,920 B, sse 39,722 -> 39,786, typebox-t 65,833 -> 65,915, typebox-form 70,797 -> 70,865
  // (Bun 1.4.4); only these four caps are crossed.
  "nifra-bare": 38.1,
  // Owned request-body cancellation and the gate's error boundary: 40,086 -> 40,337 B (Bun 1.4.3).
  // Resident-text single-use guard: measured 40,868 / 36,694 / 37,287 B for idempotency / MCP / SSE.
  // Add 0.05 KiB only to the three caps the security fix crosses.
  // Hook-handed responses held single-use (onResponse replacement, onRequest answer): idempotency
  // 41,108 -> 41,198 B, effect-ledger 38,706 -> 38,789, sse 37,535 -> 37,615, mcp 36,934 -> 37,035,
  // valibot 37,697 -> 37,782 (Bun 1.4.3).
  // A Host sent twice refused on Bun: idempotency 41,752 -> 41,794 B, bare 37,308 -> 37,349,
  // typebox-form 68,149 -> 68,189 (Bun 1.4.3); only the idempotency cap is crossed.
  // Core's shared canonical JSON, which refuses a value JSON cannot carry instead of hashing it as
  // something else: idempotency 42,874 -> 42,982 B (Bun 1.4.4); only the idempotency cap is crossed.
  // A fingerprint keeps the written text of a JSON number a double would round, behind a sampled scan
  // 3-7x cheaper than a regex over the body: idempotency 42,982 -> 43,223 B (Bun 1.4.4); only the
  // idempotency cap is crossed, by three 0.1 KiB steps.
  "nifra-idempotency": 42.7,
  "nifra-effect-ledger": 40.0,
  "nifra-mcp": 38.3,
  // The kernel's idempotency gate dispatch: 36,758 -> 36,764 B, over a 3.6 B margin (Bun 1.4.3).
  "nifra-sse": 38.9,
  "nifra-valibot": 39.0,
  "nifra-typebox-t": 64.4,
  // t.integer() bounded to the safe-integer range: typebox-form 68,734 -> 68,765 B (Bun 1.4.4).
  "nifra-typebox-form": 69.3,
  "nifra-agent-review": 5.2,
  // An intercept boundary keeps the page and its target apart (reloads, cache, actions, form owner,
  // closeBoundary): 16,559 -> 17,437 B; a revalidation's terminal status renders its status route:
  // 17,437 -> 17,540 B; numbered fragment entries, closeBoundary on /client and status-page
  // re-matching: 17,540 -> 17,718 B (Bun 1.4.3). Queries refetching on live keys and
  // QueryClient.clear(): 17,769 -> 18,212 B; every browser client held weakly from creation, so a
  // viewer switch also clears one made before the live client loaded: 18,212 -> 18,265 B (Bun 1.4.3).
  // Partial prerendering's prefetch marker and its leave hook on navigation: 18,265 -> 18,368 B.
  // A reload asks for the fill of each hole host on screen, a server component's included, and the
  // leave hook runs only for a navigation that loads: 18,368 -> 18,436 B (Bun 1.4.3).
  // A revalidation keeps the identity of what it did not change (the sharing walk, and the same
  // response text reusing the page unparsed, sampled row-ID indexing and the non-tree fallback):
  // 18,436 -> 19,387 B; parsed JSON skipping the symbol-key check: 19,431 B (Bun 1.4.4).
  // `identityChanged()`, which drops kept pages on a token sign-in or sign-out in every tab:
  // 19,431 -> 19,550 B (Bun 1.4.4). Each old row pairing with at most one new one, so duplicate IDs
  // never share an object, tracked in an index array (a Set was 69 B smaller but slowed a reordered
  // 1,000-row list 8-11%, against 3-4%): 19,648 B (Bun 1.4.4). A warmed prefetch is dropped when
  // the visitor's identity changes and when an action revalidates its path: 19,648 -> 19,844 B
  // (Bun 1.4.4). A navigation loads before its view transition, which holds only the page swap and
  // skips its animation when no frame comes: 19,844 -> 19,961 B (Bun 1.4.4). `notFound`, `gone` and
  // `statusPage`, which this row's whole-namespace import keeps and a named import tree-shakes:
  // 19,961 -> 20,178 B (Bun 1.4.4). A `bigint` in the plain transport codec as its decimal string:
  // 20,178 -> 20,228 B (Bun 1.4.4). Query clients and fetchers drop what they hold on
  // `identityChanged()` and on a new identity epoch cookie, read once per synchronous run because a
  // `document.cookie` read costs about 2.4 us in Chromium: 20,228 -> 20,519 B (Bun 1.4.4). Handles
  // and fetchers a page kept check the epoch on every read, and the page on screen reloads when the
  // visitor changes, a navigation in flight starting again: 20,519 -> 20,791 B (Bun 1.4.4). A plain
  // `Date` in the plain transport codec written ahead of the serializer: 20,791 -> 21,157 B, each getter
  // there read once: 21,218 B (Bun 1.4.4).
  "nifra-web-client": 20.8,
  "nifra-i18n": 4.3,
}

const main = async (): Promise<void> => {
  console.log(`\nBundle size - Bun.build({ minify: true }) + gzip  (Bun ${Bun.version})`)
  console.log("Deterministic: identical app shape per row, same minifier. Lower is better.")

  if (ATTRIBUTION) {
    const rows: Size[] = []
    for (const [label, source] of Object.entries(ATTRIBUTION_ROWS)) {
      const measured = await measure(label, source, { target: "bun", attribution: true })
      if (measured) rows.push(measured)
    }
    const missing = Object.keys(ATTRIBUTION_ROWS).filter(
      (label) => !rows.some((row) => row.label === label),
    )
    if (missing.length > 0) {
      throw new Error(`Bundle attribution measured fewer rows than declared: ${missing.join(", ")}`)
    }
    attributionTable(rows)
    return
  }

  const server: Size[] = []
  for (const [label, source] of Object.entries(SERVER)) {
    const s = await measure(label, source, { target: "bun" })
    if (s) server.push(s)
  }
  table("Server bundle - minimal 2-route JSON app (target: bun)", server, "bun-raw")

  const features: Size[] = []
  for (const [label, source] of Object.entries(NIFRA_FEATURES)) {
    const measured = await measure(label, source, {
      target: BROWSER_FEATURES.has(label) ? "browser" : "bun",
    })
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
  const { httpFrameworkVersion, writeSiteBench } = await import("../site-bench.ts")
  const bundle = server
    .filter((s) => s.label in SITE_LABELS)
    .map((s) => ({
      name: SITE_LABELS[s.label] as string,
      version: httpFrameworkVersion(s.label),
      kb: Math.round((s.gz / 1024) * 10) / 10,
      ...(s.label === "nifra" ? { you: true as const } : {}),
    }))
    .sort((a, b) => a.kb - b.kb)
  if (!CHECK && bundle.length === Object.keys(SITE_LABELS).length) {
    await writeSiteBench({ bundle })
  } else if (bundle.length !== Object.keys(SITE_LABELS).length) {
    console.error("  ! site bundle slice NOT updated - a framework row failed to build")
  }
}

await main().finally(() => rmSync(tmp, { recursive: true, force: true }))
