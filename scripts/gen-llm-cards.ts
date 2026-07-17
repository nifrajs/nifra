#!/usr/bin/env bun
/**
 * Generate a per-package **`packages/<pkg>/LLM.md` contract card** for every PUBLISHED (non-private)
 * package — a tight, cheap-to-read alternative to the 200 KB `llms-full.txt` corpus when an agent only
 * needs ONE package's shape. Each card carries:
 *
 *   - the package's one-line purpose (its `package.json` `description`),
 *   - its key public exports (name · kind · one-line signature), sourced from the SAME TypeScript
 *     compiler-API extraction that backs `api-reference.md` (`scripts/gen-api-reference.ts`) — never
 *     re-derived by hand, so a card can't drift from the code, and
 *   - a curated **Footguns** stanza (the 2–3 non-obvious rules an author actually trips on).
 *
 * The exports are extracted from each package's public `exports` map, so adding/removing/renaming a
 * root or subpath export changes the card on the next `gen:cards` run; `check:cards` (the `--check`
 * flag) fails CI if a committed card is stale or a published package README stops linking its card
 * and the root corpus, mirroring `check:api`. Run: `bun run gen:cards`.
 *
 * The footgun text is the one piece a generator can't derive from signatures — it's curated here, keyed
 * by package name, and reviewed like any other source. High-traffic packages get specific footguns; the
 * rest get an honest generic pointer to the full corpus.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { Glob } from "bun"
import ts from "typescript"

const ROOT = `${import.meta.dir}/..`
// A card is a quick read by design: cap the export list and the per-line signature so one card stays
// far smaller than the corpus. The full, uncapped detail lives in api-reference.md / llms-full.txt.
const SIG_CAP = 140
const MAX_EXPORTS = 14

interface Pkg {
  readonly name: string
  readonly dir: string
  readonly entries: readonly PkgEntry[]
  readonly description: string
}

interface PkgEntry {
  readonly importPath: string
  readonly entry: string
}

function sourceEntry(dir: string, target: unknown): string | undefined {
  if (typeof target === "string") {
    const entry = `${dir}/${target.replace(/^\.\//, "")}`
    return target.includes("/src/") && existsSync(entry) ? entry : undefined
  }
  if (target === null || typeof target !== "object") return undefined
  const conditions = target as Record<string, unknown>
  for (const key of ["bun", "deno", "worker", "browser", "import", "default", "types"]) {
    const entry = sourceEntry(dir, conditions[key])
    if (entry !== undefined) return entry
  }
  return undefined
}

/** Every PUBLISHED (non-private) package, sorted by name. A superset of `gen-api-reference.ts`'s
 * `publicPackages`: the api reference only documents packages with a `src/index.ts`, but a card is
 * still useful for the bin-only packages (their footguns), so those are included with no exports. */
function publicPackages(): Pkg[] {
  const pkgs: Pkg[] = []
  for (const file of new Glob("packages/*/package.json").scanSync(ROOT)) {
    const json = JSON.parse(readFileSync(`${ROOT}/${file}`, "utf8")) as {
      name?: string
      private?: boolean
      description?: string
      exports?: unknown
    }
    if (json.private === true || json.name === undefined) continue
    const dir = `${ROOT}/${file.replace(/\/package\.json$/, "")}`
    const entries: PkgEntry[] = []
    if (json.exports !== null && typeof json.exports === "object") {
      for (const [subpath, target] of Object.entries(json.exports as Record<string, unknown>)) {
        if (subpath !== "." && !subpath.startsWith("./")) continue
        const entry = sourceEntry(dir, target)
        if (entry === undefined) continue
        entries.push({
          importPath: subpath === "." ? json.name : `${json.name}/${subpath.slice(2)}`,
          entry,
        })
      }
    }
    const fallback = `${dir}/src/index.ts`
    if (entries.length === 0 && existsSync(fallback)) {
      entries.push({ importPath: json.name, entry: fallback })
    }
    entries.sort((a, b) =>
      a.importPath === json.name
        ? -1
        : b.importPath === json.name
          ? 1
          : a.importPath.localeCompare(b.importPath),
    )
    pkgs.push({
      name: json.name,
      dir,
      entries,
      description: json.description ?? "",
    })
  }
  return pkgs.sort((a, b) => a.name.localeCompare(b.name))
}

function repoOptions(): ts.CompilerOptions {
  const host: ts.ParseConfigFileHost = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} }
  const parsed = ts.getParsedCommandLineOfConfigFile(`${ROOT}/tsconfig.json`, {}, host)
  return { ...(parsed?.options ?? {}), noEmit: true, skipLibCheck: true }
}

function kindOf(decl: ts.Declaration): string {
  if (ts.isFunctionDeclaration(decl)) return "function"
  if (ts.isClassDeclaration(decl)) return "class"
  if (ts.isInterfaceDeclaration(decl)) return "interface"
  if (ts.isTypeAliasDeclaration(decl)) return "type"
  if (ts.isEnumDeclaration(decl)) return "enum"
  return "const"
}

function typeParams(decl: ts.Declaration): string {
  const tp = (decl as { typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> }).typeParameters
  return tp && tp.length > 0 ? `<${tp.map((p) => p.getText()).join(", ")}>` : ""
}

function cap(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim()
  return flat.length > SIG_CAP ? `${flat.slice(0, SIG_CAP - 1)}…` : flat
}

/** A one-line signature for the export, by declaration kind — mirrors `gen-api-reference.ts`'s
 * `signatureOf` (value types via the checker, declared types by their header). */
function signatureOf(
  name: string,
  sym: ts.Symbol,
  decl: ts.Declaration,
  checker: ts.TypeChecker,
): string {
  if (ts.isInterfaceDeclaration(decl)) return `interface ${name}${typeParams(decl)}`
  if (ts.isClassDeclaration(decl)) return `class ${name}${typeParams(decl)}`
  if (ts.isEnumDeclaration(decl)) return `enum ${name}`
  if (ts.isTypeAliasDeclaration(decl)) {
    const rhs = decl.type.getText()
    const head = `type ${name}${typeParams(decl)}`
    return rhs.length <= SIG_CAP ? cap(`${head} = ${rhs}`) : head
  }
  const type = checker.typeToString(
    checker.getTypeOfSymbolAtLocation(sym, decl),
    decl,
    ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.WriteArrowStyleSignature,
  )
  return cap(`${name}: ${type}`)
}

interface ExportRow {
  readonly name: string
  readonly kind: string
  readonly sig: string
  readonly importPath: string
}

/** Order exports for the card: functions/classes (the things you call) before interfaces/types
 * (their shapes), then alphabetical — so the "what do I call" surface leads. */
const KIND_RANK: Record<string, number> = {
  function: 0,
  class: 1,
  const: 2,
  enum: 3,
  interface: 4,
  type: 5,
}

const KEY_EXPORT_RANK = new Map(
  [
    "server",
    "defineContract",
    "implement",
    "definePlugin",
    "client",
    "inProcessClient",
    "testClient",
    "createWebApp",
    "t",
    "sse",
    "idempotency",
    "effectLedger",
  ].map((name, index) => [name, index]),
)

/** Curated, reviewed footguns per package — the one part a generator can't derive from signatures.
 * Keyed by package name. High-traffic packages carry specific rules; everything else falls back to the
 * generic pointer (so a low-traffic package still gets an honest, non-empty stanza without invented detail).
 * Keep each bullet to the non-obvious rule + the fix, not a tutorial. */
const FOOTGUNS: Record<string, readonly string[]> = {
  "@nifrajs/core": [
    "The package root is the lean HTTP server API. Enable optional systems with `.use()` plugins from their subpaths - `.use(mcp())` from `@nifrajs/core/mcp`, `.use(streaming())` from `@nifrajs/core/sse`, `.use(idempotency())`, `.use(effectLedger())`; the root activates none of them.",
    "`t.object({...})` (and any object schema) rejects **unknown fields** by default (`additionalProperties: false`) → a structured `422 { path: [...] }` **before** the handler runs. Use `t.looseObject` to allow extras.",
    '**Throw rule:** `throw new Response("", { status: 404 })` is control flow — returned as-is, bypasses `_error`. `throw new Error(…)` hits the nearest `_error` boundary / a 500. Do not throw a `Response` to signal a bug, and do not `throw new Error` to send a 4xx.',
    "Type the env ONCE on `server<Env>()` → `c.env` is typed on every route below (no per-binding cast). Without `<Env>`, `c.env` is `unknown`. Still validate untrusted env at the boundary.",
  ],
  "@nifrajs/client": [
    "**The client never throws.** Every call returns `{ ok, status, data, error }` — branch on `res.ok`, never `try/catch`. A network failure is `ok: false`, not an exception.",
    "Import the server's app **type-only**: `import type { app }` + `client<typeof app>(url)`. The value import would pull server code (and its `node:` deps) into the browser bundle.",
    "`inProcessClient(app)` is a **callable proxy** with the same shape as `client()` but no network — use it in SSR loaders and tests. It mutates/serves the real app in-process; it is not a mock.",
  ],
  "@nifrajs/testing": [
    "`assertAdversarialContract` executes one valid request for every declared response schema. Use an isolated test app/database; never point a contract laboratory at production.",
    'An opaque Standard Schema validates normally but cannot synthesize its own known-good input. Supply `witnesses["METHOD /path"]`; missing/invalid witnesses are coverage gaps, never silent passes.',
    "Query mutations are proved invalid after URL serialization, and every failure carries `{ seed, caseId, runtime }`; replay one with `only: caseId`.",
  ],
  "@nifrajs/schema": [
    "`t.object` is **strict** — unknown keys → `400`. Reach for `t.looseObject` only when extra keys are intentional.",
    "`t` is TypeBox-backed and implements **Standard Schema**, so a nifra route accepts it natively (no adapter). zod/valibot/arktype work the same way at the route boundary.",
  ],
  "@nifrajs/web": [
    "`meta()` runs at **module load**, before any request — it has **no access to request env or `c.env`**. For the request origin (canonical/OG URLs) read `args.origin` in the meta function, never a build-time constant.",
    '**Client-leak rule (three guards):** name a server module `*.server.ts` (client build empties it) · add `import "@nifrajs/web/server-only"` to a pure-server module with no `node:` import (build fails loud, with the import chain, if it reaches the browser) · type a value `ServerOnly<T>` to mark intent. A `node:`/native import that reaches a client chunk fails the build with `reached the client bundle` + the chain. See `/docs/troubleshooting`.',
    "`PUBLIC_*` env is baked into the **client** bundle; any other `process.env.X` is `undefined` in the browser (so secrets can't leak, no `process is not defined` crash). Loader data arrives as **`props.data`**, not spread into props.",
  ],
  "@nifrajs/web-react": [
    "React is **deduped** in both the build and the Vite dev server, so a `file:`-linked package shipping its own React no longer nulls the SSR hook dispatcher (`Invalid hook call` / `resolveDispatcher`). See `/docs/troubleshooting`.",
    "A route file that exports `loader`/`action`/`meta` is **not a Fast-Refresh boundary** — keep the view in a child component for state-preserving HMR.",
  ],
  "@nifrajs/web-preact": [
    "Preact is **deduped** in build + dev; a duplicate copy breaks hooks the same way React does.",
    "Set `hydrate={false}` (or `export const hydrate = false`) on a static, interaction-free page to ship **zero** client JS for it.",
  ],
  "@nifrajs/web-vue": [
    "The `.vue` SFC compiler is a **Bun plugin** (`@nifrajs/web-vue/plugin`) you must preload for server rendering — without it the SFC import fails at build/SSR.",
    "`<style scoped>` is compiled and folded into the app stylesheet; no runtime, no FOUC.",
  ],
  "@nifrajs/web-svelte": [
    "The `.svelte` compiler is a **Bun plugin** (`@nifrajs/web-svelte/plugin`) you must preload for SSR. attw/`.d.ts` don't model `.svelte`, so resolution flows through the consumer's Svelte toolchain.",
    "Svelte HMR re-runs the edited component, so its own local state resets on edit (the page itself doesn't reload).",
  ],
  "@nifrajs/web-solid": [
    'Solid needs its **Babel build plugin** (and `solid({ ssr: true })` + the `"solid"` resolve condition) — without it, reactivity/SSR breaks.',
    "Each framework build is isolated so Solid's Babel transform never leaks onto React/Preact `.tsx`.",
  ],
  "@nifrajs/web-vanilla": [
    "Output is **auto-escaping** tagged-template HTML — interpolated values are escaped; opt into raw HTML explicitly, and only for trusted content.",
    "Interactivity comes from islands (`@nifrajs/web/islands` + `@nifrajs/islets`), not a framework runtime — ~0 KB client JS by default.",
  ],
  "@nifrajs/islets": [
    "Signals are **fine-grained** — read them where you bind, not eagerly into locals, or you lose reactivity.",
    "This is the client companion to `@nifrajs/web-vanilla`; it ships interactivity in ~1 KB with no framework runtime.",
  ],
  "@nifrajs/auth": [
    "nifra owns the **session**, not identity — bring your own auth (Better Auth / Lucia / OAuth). Don't expect user/login primitives here.",
    "Session cookies are signed; the secret comparison is constant-time. Pair the route guard with a repository-layer ownership (IDOR) check — a valid session is **authN, not authZ**.",
  ],
  "@nifrajs/better-auth": [
    "`app.use()` wires `/api/auth/*`; the typed `getSession`/`requireSession` guards are how you read the session downstream.",
    "Structural typing means **no hard dependency** on better-auth — match the expected shape, don't assume a specific version's internals.",
  ],
  "@nifrajs/env": [
    "Validation runs at **boot** and fails loud, listing **every** problem at once (not the first). Wire it before the server starts so a bad deploy never serves traffic.",
    "The returned object is **frozen** — read-only at runtime. Define the schema once; don't reach for `process.env.X` past the boundary.",
  ],
  "@nifrajs/uploads": [
    "MIME is detected from **magic bytes**, never the `Content-Type` header — validate the real bytes, enforce the size cap, and strip EXIF before storing.",
    "Signed download URLs carry the **shortest viable TTL** — re-sign on demand, don't cache a long-lived URL.",
  ],
  "@nifrajs/image": [
    "`<Image>` is **CLS-safe** — pass intrinsic `width`/`height` (or the reader fills them) so the layout doesn't shift.",
    "The resize endpoint is **opt-in** (`@nifrajs/image/server`, Bun.Image-backed); the core stays zero-dependency and runs on the edge.",
  ],
  "@nifrajs/i18n": [
    "The message formatter is a **tiny ICU** layer on the platform `Intl` — it isn't full ICU MessageFormat; check the supported syntax before porting complex messages.",
    "Locale negotiation reads the request; resolve the locale at the boundary and thread it, don't read a global.",
  ],
  "@nifrajs/middleware": [
    "Middleware is **fail-closed** by default — a throwing/denying middleware blocks the request rather than letting it through. Order matters: auth/CSRF before handlers.",
    "Response-cache and body-limit middleware act on the request lifecycle — mount them at the right scope (app vs route) so they don't over- or under-apply.",
  ],
  "@nifrajs/cron": [
    "In-process and for **long-running servers only** (Bun/Node/Deno). On Cloudflare Workers use the platform **scheduled trigger** — an in-process cron won't fire on a per-request worker.",
    "Jobs are **overlap-safe** (a still-running job won't re-enter) and error-isolated; call the graceful `stop()` on shutdown so an in-flight job finishes.",
  ],
  "@nifrajs/otel": [
    "**No OpenTelemetry SDK is bundled** — you provide the exporter (bridge to the OTel SDK or log spans directly). Edge-safe by design.",
    "Propagation is **W3C traceparent/tracestate** — read it off the incoming request and forward it on outbound calls or the trace breaks.",
  ],
  "@nifrajs/content": [
    "Collections are **schema-validated** at load — a frontmatter mismatch fails loudly, it doesn't silently coerce.",
    "Framework-agnostic: the parsed content is data, not framework components — render it with whichever adapter you use.",
  ],
  "@nifrajs/runner": [
    "The runner executes a real `app.fetch` and captures **structured** results — it's the engine behind the playground and the agent run/verify tool, not a mock.",
    "Dependency-free and runs everywhere (browser/Bun/Node/Deno/edge) — don't reach for `node:` APIs in code you hand it.",
  ],
  "@nifrajs/node": [
    "Adapts Node's `http` server via a `Request`<->stream bridge; call the graceful `stop()` so in-flight requests drain on shutdown.",
  ],
  "@nifrajs/deno": [
    "Runs on `Deno.serve` with a graceful `stop()`; OS signal handling is **opt-in** (Deno permissions), not automatic.",
  ],
  "@nifrajs/workers": [
    "The WebSocket hub is a **Durable Object** — broadcast is cross-connection via the DO, not in-memory per-isolate (a plain Worker can't fan out across connections).",
  ],
  "@nifrajs/cli": [
    "`nifra check` (`--json` for agents) is the **done-gate**: typecheck + typed-client drift + server-only-import-in-a-route (with the transitive import chain) + raw-`Response`-from-a-route + undeclared dependency.",
    "`nifra dev` uses Vite for HMR; `nifra build` emits a complete deploy and defaults to Bun (`--target` selects node/deno/cf-pages/vercel/static). Keep the deploy-safe adapter in `framework.ts` and Vite/compiler tooling in CLI-only `nifra.config.ts`.",
    "`nifra mcp` exposes live project tools (`nifra_docs`, `nifra_example`, `nifra_check`) to an agent.",
  ],
  nifra: [
    'This is the unscoped **meta-entry** — it re-exports `@nifrajs/core` only, so `import { server } from "nifra"` works. Everything else (web, client, schema, …) lives under `@nifrajs/*`; import those directly.',
  ],
  "create-nifra": [
    "Scaffolding CLI (`bun create nifra <dir>`), not a library — there are no runtime exports to import.",
  ],
}

const GENERIC_FOOTGUN =
  "No package-specific footguns beyond the framework conventions. See [`AGENTS.md`](../../AGENTS.md) and [`llms-full.txt`](../../llms-full.txt) for the full contract."

/** Build the markdown card for one package. The export list is the generated, drift-proof part; the
 * purpose + footguns are curated/sourced from package.json. */
function cardFor(pkg: Pkg, exports: readonly ExportRow[]): string {
  const shown = exports.slice(0, MAX_EXPORTS)
  const more = exports.length - shown.length
  const footguns = FOOTGUNS[pkg.name] ?? [GENERIC_FOOTGUN]

  const lines: string[] = [
    `# ${pkg.name} — LLM contract card`,
    "",
    "<!-- GENERATED by scripts/gen-llm-cards.ts. Do not edit by hand — run `bun run gen:cards`. -->",
    "",
    pkg.description || "_(no description)_",
    "",
    "> A tight contract card for AI agents: the exports you actually call + the footguns. For the full",
    "> reference see [`api-reference.md`](../../api-reference.md) (every export + signature) and",
    "> [`llms-full.txt`](../../llms-full.txt) (the prose guides). One cheap read instead of the whole corpus.",
    "",
  ]
  if (pkg.entries.length > 1) {
    lines.push(
      "## Public entrypoints",
      "",
      pkg.entries.map((entry) => `\`${entry.importPath}\``).join(" · "),
      "",
    )
  }
  lines.push("## Key exports", "")
  if (shown.length === 0) {
    lines.push("_No public value/type exports (CLI or side-effect package)._")
  } else {
    for (const e of shown) {
      lines.push(
        `- **${e.name}** _(${e.kind})_ — \`${e.sig}\`${pkg.entries.length > 1 ? ` · from \`${e.importPath}\`` : ""}`,
      )
    }
    if (more > 0) {
      lines.push(
        "",
        `_…and ${more} more — see [\`api-reference.md\`](../../api-reference.md#${pkg.name.replace(/[^a-z0-9]+/gi, "").toLowerCase()}) for the complete list._`,
      )
    }
  }
  lines.push("", "## Footguns", "")
  for (const f of footguns) lines.push(`- ${f}`)
  lines.push("")
  return lines.join("\n")
}

/** Extract ranked, name-deduplicated exports from every public package entrypoint. */
function extractExports(pkgs: readonly Pkg[]): Map<string, ExportRow[]> {
  const entries = pkgs.flatMap((pkg) => pkg.entries.map((entry) => entry.entry))
  const program = ts.createProgram(entries, repoOptions())
  const checker = program.getTypeChecker()
  const byPkg = new Map<string, ExportRow[]>()
  for (const pkg of pkgs) {
    const rowsByName = new Map<string, ExportRow>()
    for (const entry of pkg.entries) {
      const sf = program.getSourceFile(entry.entry)
      const moduleSym = sf ? checker.getSymbolAtLocation(sf) : undefined
      if (!moduleSym) continue
      for (const raw of checker.getExportsOfModule(moduleSym)) {
        const sym = raw.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(raw) : raw
        const decl = sym.getDeclarations()?.[0]
        if (!decl) continue
        if (rowsByName.has(raw.getName())) continue
        rowsByName.set(raw.getName(), {
          name: raw.getName(),
          kind: kindOf(decl),
          sig: signatureOf(raw.getName(), sym, decl, checker),
          importPath: entry.importPath,
        })
      }
    }
    const rows = [...rowsByName.values()]
    rows.sort(
      (a, b) =>
        (KEY_EXPORT_RANK.get(a.name) ?? 99) - (KEY_EXPORT_RANK.get(b.name) ?? 99) ||
        (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9) ||
        a.name.localeCompare(b.name),
    )
    byPkg.set(pkg.name, rows)
  }
  return byPkg
}

interface Card {
  readonly pkg: Pkg
  readonly path: string
  readonly content: string
}

/** Published package READMEs are the npm landing page for both humans and agents. Keep the two
 * machine-readable entrypoints discoverable there as packages are added after this generator. */
function readmeIssues(pkgs: readonly Pkg[]): string[] {
  const issues: string[] = []
  for (const pkg of pkgs) {
    const path = `${pkg.dir}/README.md`
    if (!existsSync(path)) {
      issues.push(`${pkg.name}: missing README.md`)
      continue
    }

    const readme = readFileSync(path, "utf8")
    const missing: string[] = []
    if (!readme.includes("](./LLM.md)")) missing.push("./LLM.md")
    if (!readme.includes("](../../llms-full.txt)")) missing.push("../../llms-full.txt")
    if (missing.length > 0) {
      issues.push(`${pkg.name}: README.md does not link ${missing.join(" and ")}`)
    }
  }
  return issues
}

export function generateCards(): Card[] {
  const pkgs = publicPackages()
  const exportsByPkg = extractExports(pkgs)
  return pkgs.map((pkg) => ({
    pkg,
    path: `${pkg.dir}/LLM.md`,
    content: cardFor(pkg, exportsByPkg.get(pkg.name) ?? []),
  }))
}

if (import.meta.main) {
  const cards = generateCards()
  // Sanity-check: the high-traffic packages must produce a non-trivial card, so a broken extractor
  // (e.g. a resolution change that empties the export list) fails loudly rather than shipping stubs.
  const web = cards.find((c) => c.pkg.name === "@nifrajs/web")?.content ?? ""
  if (!web.includes("## Footguns") || !web.includes("reached the client bundle")) {
    console.error("✗ LLM.md card generation looks broken (missing @nifrajs/web footguns)")
    process.exit(1)
  }

  if (process.argv.includes("--check")) {
    const readmeProblems = readmeIssues(cards.map((card) => card.pkg))
    if (readmeProblems.length > 0) {
      console.error(
        `✗ ${readmeProblems.length} published package README issue(s):\n` +
          readmeProblems.map((issue) => `  - ${issue}`).join("\n"),
      )
      process.exit(1)
    }

    const stale = cards.filter(
      (c) => (existsSync(c.path) ? readFileSync(c.path, "utf8") : "") !== c.content,
    )
    if (stale.length > 0) {
      console.error(
        `✗ ${stale.length} LLM.md card(s) are stale — run \`bun run gen:cards\` and commit:\n` +
          stale.map((c) => `  - ${c.pkg.name}`).join("\n"),
      )
      process.exit(1)
    }
    console.log(`✓ all ${cards.length} LLM.md cards and package README pointers are up to date`)
  } else {
    for (const c of cards) writeFileSync(c.path, c.content)
    console.log(`Generated ${cards.length} LLM.md contract cards (one per published package).`)
  }
}
