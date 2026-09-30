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
  // kernel, both of which are Phase 6 regressions, not repricings.
  "nifra-agent-review": `import { composeReviewReport, digestReviewReport } from "@nifrajs/agent-review"
console.log(typeof composeReviewReport, typeof digestReviewReport)`,
  // Browser row, not a server row: everything the generated client entry imports, which is the
  // router store, history and link interception, head updates and form handling. It is the payload a
  // page ships before any framework adapter, so a route-tree or navigation feature that lands in it
  // is paid by every visitor. The whole namespace is kept so the row does not depend on which
  // exports a given app happens to use.
  "nifra-web-client": `import * as client from "@nifrajs/web/client"
console.log(client)`,
}

/** Rows bundled for the browser. Every other feature row is a server bundle. */
const BROWSER_FEATURES: ReadonlySet<string> = new Set(["nifra-web-client"])

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
// The static response-header tier remains in the default kernel because it folds into response
// construction without a per-request observer walk. The portable header/body/raw observer adapters
// are installed from `@nifrajs/core/response-observer`; the minimal server measured 26.2 -> 25.5 KB
// gzip after the adapters moved behind that seam. Middleware using those tiers carries the opt-in
// runtime marker, so ordinary core bundles do not reach the observer implementation.
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
// Two moves are priced into the ceilings below. The larger one predates this repricing and had
// already put every row over: the transport-cap and portable-tier work above landed without the
// table being brought forward, so the gate was failing on numbers nobody had accepted (bare measured
// 25.1 KB against a 24.7 ceiling). The smaller one is current: a declared WebSocket payload cap
// carried on the upgrade outcome, `errorLogDetail`'s registration-time choice of what an error log
// carries, and the header-case proof the response walk publishes for its readers - together +0.25 KB
// gzip, uniform across the matrix (bare 25.1 -> 25.3), because all three sit in the kernel where any
// route can reach them. Every ceiling is now the measured number plus ~0.2 KB, so a regression of the
// same size as that batch still trips the gate rather than fitting inside the slack.
// Two forces moved the ceilings this round; the net is +~0.1 KB gzip, uniform across the matrix (bare
// 25.3 -> 25.6). CREDIT: the `c.json`/`c.text` Node fast lane's deferred-`Response` stand-in left the
// core bundle (~0.25 KB gzip off bare). It is a Node-only optimization - Bun and Deno hand a real
// `Response` to their native server and never take the branch - so it now lives in `@nifrajs/node`,
// handed to core over the shared `Symbol.for` seam and shipped only in a Node bundle. COST, larger:
// the regex pathological-input hardening (bounded matchers over untrusted path/query input) and the
// per-route direct body-read caps both sit in the kernel where any route on any runtime can reach
// them, so their ~0.35 KB gzip is paid once in `nifra-bare` and inherited. Same rule as before: each
// ceiling is the measured number plus ~0.2 KB, tight enough that a regression of that size still trips.
// The roadmap's plain-data response carriers and early-exit handling then added ~0.6 KB gzip to the
// shared core kernel (bare 25.6 -> 26.2). This is deliberately accepted as a uniform seam cost: the
// safer status/validation path replaces per-request Response construction and does not make any
// optional package reachable. The ceilings below retain the same ~0.2 KB headroom over the measured
// matrix; a further shared-kernel increase still fails all affected rows together. Fused
// derive/before/after lifecycle lanes plus the opt-in Node body-hook twin add ~0.5 KB gzip to
// the shared server kernel, accepted here alongside the measured hot-path win on middleware-heavy
// routes. Reprice every affected row from the current deterministic matrix with the usual ~0.2 KB
// headroom; the budget remains a regression tripwire for later kernel growth.
// The 2026-09-28 assurance/auth route program and composed evidence checks add the next measured shared
// kernel batch: 1.9 KB gzip on the bare row, with optional rows moving by the same reachable core
// footprint. Core, middleware, and edge-startup gates remain separate required evidence; this is a
// narrow repricing of measured feature cost, not an exemption for unbounded growth.
// Typed prefix groups (`group()`) add ~0.67 KB gzip to the shared kernel (bare 30687 -> 31371 B,
// measured against its parent commit, which already sat 70 B over the 29.9 ceiling). The method has
// to be a `Server` member for the builder to inherit the parent's typed context, so it cannot move
// behind a subpath the way the WS/SSE runtimes did. Of the cost, ~0.35 KB is the method itself (the
// prefix grammar, the scope fork, the fail-closed builder contract and refusals); the rest is the
// path join at registration and the prefix-scoped hook gating in the adoption code `merge()` shares.
// Squeezed first: the fork and the runtime hoist walk field-name lists instead of one statement per
// field (which also shrank `merge()`), one gate helper wraps every hook kind, and the messages were
// cut - together 0.33 KB back from the first cut. Nothing runs per request unless a group registers
// a hook. Every row moves by the same kernel bytes; ceilings are the measured number plus ~0.2 KB.
// File uploads are priced as their own row, `nifra-typebox-form` (measured 64.7 KB), not on `t`. The
// constructors were first measured on the root builder, where they cost every `t` user +2.2 KB gzip
// (60.6 -> 62.8) for the signature table, the form validator and the multipart reader. They now sit
// on the builder of `@nifrajs/schema/form`, so that cost is paid only by an app that imports it.
// What stays on `t` is ~0.1 KB (measured 62255 B): the marker that lets `t.array`/`t.optional` hand
// a file schema to its own constructors, and the refusal when one reaches a constructor that
// validates JSON. That guard has to live on `t`: without it a file field inside `t.object` would
// build a schema that rejects every request. Squeezed first: the refusal message was cut to one line.
// A mixed path segment (`/:name.json`, `/v:major.:minor`) is matched by one pass over the segment
// instead of a compiled pattern, so a lookup costs the segment's length whatever the parameter count.
// The scanner is +53 B gzip in the router (bare 31539 -> 31592 B), inherited by every row. Squeezed
// first, from +182 B: a segment's shape is a flat list of its literals rather than a record, the
// capture count is read off that list, and the trie keys a shape by those literals, which takes the
// pattern-source builder and its escaper out of the kernel. The baseline sat exactly on the bare
// ceiling, so the three rows with no slack left move by 0.1 KB; the other rows still clear theirs.
// A custom answer for unmatched requests (`notFound()`) lives on its own subpath; the kernel keeps
// the install seam and one branch at the 404 site: +49 B gzip (bare 31592 -> 31641 B), inherited by
// every row, and nothing else of the feature is reachable from an app that does not import it.
// Writing the field from the plugin instead of through the seam measures 12 B smaller and was not
// taken: the seam is what refuses an install after `listen()`. The four rows with no slack left move
// by 0.1 KB; the other rows still clear theirs.
// Optional path parameters (`/users/:id?`) are expanded to their concrete paths when a route is
// registered: +103 B gzip (bare 31641 -> 31744 B), inherited by every row. That is the expansion
// itself plus one loop at the HTTP and WebSocket registration sites; nothing is added to a lookup.
// Squeezed first, from +122 B: the matcher does not expand, its callers do, which also keeps the
// feature out of the browser row (the client router bundles the matcher and measured +137 B with
// the expansion inside it, 0 B now). Seven rows had no slack left and move by 0.1 KB.
// A route can be registered under a method outside the standard seven (`method("PURGE", ...)` from
// its own subpath): +34 B gzip (bare 31744 -> 31778 B), inherited by every row. 31 B is the matcher's
// method check, which was a lookup in a set of seven and is now a token pattern that also refuses
// `TRACE`, `CONNECT` and `TRACK`; it stays in the matcher so no caller can register one of those.
// 13 B keeps a custom method out of Bun's native route table. The registration functions themselves
// are not reachable from an app that does not import them. Four rows had no slack left and move by
// 0.1 KB; the other rows still clear theirs.
// On Bun, `listen()` serves a route from Bun's own route table only when Bun would pick it for exactly
// the requests the portable matcher gives it: +320 B gzip (bare 31778 -> 32098 B), inherited by every
// row. Bun chooses among the paths registered for the request's method and reads `/:name.json` as one
// parameter, so three things are settled before the first request: which table paths are outranked
// by a path the table cannot hold, which methods a less specific path serves, and the portable
// dispatcher entries that stop Bun at the more specific path. The cost is the comparison of two
// paths, the index that keeps the pass linear in the route count (a plain pairwise scan measured
// 272 ms at 3000 routes against 4 ms), and those entries. It lives in the server because `listen()`
// does; nothing of it runs per request. Two other shapes were measured first: taking every outranked
// route out of the table costs the same bytes and moves a `GET /users/:id` beside a `POST
// /users/login` off the native lane, and an entry under every method on every path is 76 B smaller
// and triples the time `Bun.serve` takes to accept a 3000-route table. Every kernel row moves by
// 0.3 KB; the ceiling is the measured number rounded up to the next 0.1 KB.
// On Bun, `c.clientIp` is the socket peer on a route served from Bun's route table, as it already
// was on every other route: +65 B gzip (bare 32098 -> 32163 B), inherited by every row. The table's
// requests share one platform that holds a lookup instead of an address, and the context asks it
// when a handler reads `c.clientIp`, so a request whose handler never reads it allocates nothing and
// asks Bun nothing. 5 B of it keeps the first answer, because Bun stops naming the peer once the
// connection is closed. An idempotent route leaves the table, since its handler runs on a buffered
// copy of the request that Bun cannot name a peer for. Squeezed first, from +71 B: the key the
// lookup sits under carries no description. Sending a malformed parameter to the dispatcher without
// the peer measured 5 B larger and was not taken. Three rows had no slack left and move by 0.1 KB;
// the other rows still clear theirs.
// A path parameter can carry a constraint (`/users/:id{[0-9]+}`, `/img/:kind{thumb|full}`): +753 B
// gzip (bare 32163 -> 32916 B), inherited by every row, and +768 B on the browser row (14079 ->
// 14847 B), which matches with the same router so that a path means the same thing on both sides.
// About 440 B is the reader that turns the text into a table at registration, 80 B the ordering that
// puts a narrower constraint first, 75 B the per-value test, 70 B the router keying a position by
// what it accepts. No pattern text becomes a `RegExp`: a class is a 128-character mask and a list a
// set of its values, so a value is tested in one pass with no backtracking. Building a `RegExp` from
// the checked class would be smaller and was not taken, because it gives that guarantee to the
// engine. Squeezed first, from +823 B: the optional-parameter pattern went (the segment splitter
// answers the same question), the reader has one exit, and the table is a string instead of a frozen
// array of words, which was also several times slower to read. An app that registers no constraint
// runs none of it per request. Every kernel row and the browser row are repriced at the measured
// number rounded up to the next 0.1 KB.
const FEATURE_GZIP_BUDGET_KB: Readonly<Record<string, number>> = {
  // The 2026-09-20 security pass adds bounded WebSocket admission/request-hook handling and
  // duplicate-cookie detection to the shared kernel. Reprice every core row together with the
  // measured post-hardening footprint; optional rows must not receive a special exemption.
  "nifra-bare": 32.2,
  // Shared effect evidence plus the explicit atomic safe-retry release path adds ~0.2 KB gzip.
  "nifra-idempotency": 35.3,
  "nifra-effect-ledger": 34.1,
  "nifra-mcp": 32.5,
  "nifra-sse": 32.9,
  "nifra-valibot": 33.2,
  "nifra-typebox-t": 62.3,
  "nifra-typebox-form": 66.1,
  // Review-leaf ceiling: measured 5.0 KB gz + ~0.2 KB headroom, same rule as every other row.
  "nifra-agent-review": 5.2,
  // Client runtime ceiling: measured 14.5 KB gz (14847 B), rounded up to the next 0.1 KB.
  "nifra-web-client": 14.5,
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
