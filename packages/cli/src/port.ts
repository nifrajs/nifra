/**
 * `nifra port` — a portability linter. It scans an app's source for features whose runtime guarantees
 * differ across deploy targets, prints a feature × target capability matrix, and (in CI mode) fails
 * when a *detected* feature is unsupported on the app's resolved deploy target.
 *
 * The premise: nifra runs the same app on five targets (Bun, Node, Deno, Cloudflare Pages, Vercel), but
 * a per-instance in-memory store, a long-lived in-process cron loop, or a `Bun.*` global is portable
 * across some and a silent footgun on others. The framework's stores already *runtime*-guard this (e.g.
 * `MemorySessionStore` throws under `NODE_ENV=production`); `port` is the *build-time* counterpart — it
 * tells you before you deploy, and gates CI so the regression can't ship.
 *
 * Detection works on reliable import/symbol signals only (a real `@nifrajs/*` import paired with the
 * exact exported symbol, a `node:` specifier, a `Bun.`/`Deno.` global), recording `file:line` evidence
 * per hit. The pure scanners are unit-tested; correctness of detection IS the product for a linter.
 */

import { join } from "node:path"
import { Glob } from "bun"
import { stripComments } from "./check.ts"

/** The five deploy targets a nifra `site` app can build for (mirrors create-nifra's DEPLOY presets). */
export const TARGETS = ["bun", "node", "deno", "cf-pages", "vercel"] as const
export type Target = (typeof TARGETS)[number]

const isTarget = (value: string): value is Target => (TARGETS as readonly string[]).includes(value)

/** The portability hazards `port` detects. Stable ids — they're part of the `--json` contract. */
export const FEATURE_IDS = [
  "in-memory-session-store",
  "in-memory-isr-cache",
  "in-memory-rate-limit",
  "in-process-cron",
  "in-process-websocket",
  "bun-runtime-api",
  "deno-runtime-api",
  "node-builtin",
] as const
export type FeatureId = (typeof FEATURE_IDS)[number]

/** A target's verdict for one feature: fully fine, works-with-a-caveat, or won't work at all. */
export type Verdict = "ok" | "caveat" | "unsupported"

/** A single feature's capability row: a human label, the per-target verdicts, and a reason per verdict. */
interface FeatureSpec {
  readonly label: string
  /** Short explanation of WHY this feature is a portability hazard at all (printed in the legend/report). */
  readonly summary: string
  readonly verdicts: Readonly<Record<Target, Verdict>>
  /** Per-target reason — why this verdict, and (for caveat/unsupported) the fix. */
  readonly reasons: Readonly<Record<Target, string>>
}

// In-memory stores (session/ISR/rate-limit) share a verdict shape: fine single-instance on a long-lived
// runtime (caveat — lost on restart, not shared across instances), unsupported on the distributed edge.
const inMemoryVerdicts: Readonly<Record<Target, Verdict>> = {
  bun: "caveat",
  node: "caveat",
  deno: "caveat",
  "cf-pages": "unsupported",
  vercel: "unsupported",
}
const inMemoryReasons = (shared: string): Readonly<Record<Target, string>> => ({
  bun: "ok single-instance; state is lost on restart and not shared across instances",
  node: "ok single-instance; state is lost on restart and not shared across instances",
  deno: "ok single-instance; state is lost on restart and not shared across instances",
  "cf-pages": shared,
  vercel: shared,
})

/**
 * The capability matrix. The source of truth for every verdict + reason `port` prints. Verdicts mirror
 * the framework's own runtime guards: the in-memory stores all `throw` under production multi-instance,
 * cron documents the Workers `scheduled` trigger as its edge replacement, and the WS hub is the Workers
 * cross-connection broadcast story.
 */
export const FEATURES: Readonly<Record<FeatureId, FeatureSpec>> = {
  "in-memory-session-store": {
    label: "in-memory session store",
    summary: "MemorySessionStore keeps sessions per-instance (@nifrajs/auth)",
    verdicts: inMemoryVerdicts,
    reasons: inMemoryReasons(
      "distributed edge has no shared per-instance memory — use KVSessionStore (Workers KV) or another shared store",
    ),
  },
  "in-memory-isr-cache": {
    label: "in-memory ISR cache",
    summary: "MemoryCacheStore caches rendered pages per-instance (@nifrajs/web)",
    verdicts: inMemoryVerdicts,
    reasons: inMemoryReasons(
      "each edge instance caches separately and revalidation won't propagate — use KVCacheStore (Workers KV) or the platform Cache API",
    ),
  },
  "in-memory-rate-limit": {
    label: "in-memory rate limit",
    summary: "MemoryStore counts hits per-instance (@nifrajs/middleware)",
    verdicts: inMemoryVerdicts,
    reasons: inMemoryReasons(
      "a per-instance limiter doesn't hold across edge instances — use a shared store (Redis / Durable Object)",
    ),
  },
  "in-process-cron": {
    label: "in-process cron",
    summary: "createScheduler runs a long-lived in-process loop (@nifrajs/cron)",
    verdicts: {
      bun: "ok",
      node: "ok",
      deno: "ok",
      "cf-pages": "caveat",
      vercel: "unsupported",
    },
    reasons: {
      bun: "long-lived process runs the scheduler loop",
      node: "long-lived process runs the scheduler loop",
      deno: "long-lived process runs the scheduler loop",
      "cf-pages":
        "no long-lived loop on Workers — use the platform `scheduled` trigger via toFetchHandler(app, { scheduled }) and a wrangler [triggers] cron",
      vercel: "no long-lived process — use a Vercel Cron Job hitting an endpoint",
    },
  },
  "in-process-websocket": {
    label: "in-process WebSocket",
    summary: "app.ws() without createWebSocketHub broadcasts only within one process",
    verdicts: {
      bun: "ok",
      node: "ok",
      deno: "ok",
      "cf-pages": "caveat",
      vercel: "unsupported",
    },
    reasons: {
      bun: "all sockets live in one process; app.publish broadcasts to every client",
      node: "all sockets live in one process; app.publish broadcasts to every client",
      deno: "all sockets live in one process; app.publish broadcasts to every client",
      "cf-pages":
        "a stateless fetch can't broadcast across isolates — wrap the app in createWebSocketHub (a Durable Object) from @nifrajs/workers",
      vercel: "Vercel's serverless functions don't hold long-lived WebSocket connections",
    },
  },
  "bun-runtime-api": {
    label: "Bun.* runtime API",
    summary: "Bun.* globals (Bun.serve, Bun.file, …) exist only on the Bun runtime",
    verdicts: {
      bun: "ok",
      node: "unsupported",
      deno: "unsupported",
      "cf-pages": "unsupported",
      vercel: "unsupported",
    },
    reasons: {
      bun: "the Bun runtime provides the Bun global",
      node: "no Bun global on Node — use the node: / Web equivalents",
      deno: "no Bun global on Deno — use the Deno / Web equivalents",
      "cf-pages": "no Bun global in the Workers runtime",
      vercel: "no Bun global in the Vercel runtime",
    },
  },
  "deno-runtime-api": {
    label: "Deno.* runtime API",
    summary: "Deno.* globals exist only on the Deno runtime",
    verdicts: {
      bun: "unsupported",
      node: "unsupported",
      deno: "ok",
      "cf-pages": "unsupported",
      vercel: "unsupported",
    },
    reasons: {
      bun: "no Deno global on Bun — use the Bun / Web equivalents",
      node: "no Deno global on Node — use the node: / Web equivalents",
      deno: "the Deno runtime provides the Deno global",
      "cf-pages": "no Deno global in the Workers runtime",
      vercel: "no Deno global in the Vercel runtime",
    },
  },
  "node-builtin": {
    label: "node: builtin",
    summary: "node:* builtins (node:fs, node:crypto, …) need a Node-compatible runtime",
    verdicts: {
      bun: "ok",
      node: "ok",
      deno: "ok",
      "cf-pages": "caveat",
      vercel: "caveat",
    },
    reasons: {
      bun: "Bun implements the node: builtins",
      node: "native node: builtins",
      deno: "Deno implements the node: builtins",
      "cf-pages":
        'Workers needs `compatibility_flags = ["nodejs_compat"]` in wrangler.toml (and not every builtin is covered)',
      vercel: "needs the Node.js runtime (not the Edge runtime) so node: builtins resolve",
    },
  },
}

/** A `file:line` evidence site for a detected feature. */
export interface Evidence {
  readonly file: string
  readonly line: number
  /** The trimmed source line — the signal in context, for the human report. */
  readonly snippet: string
}

/** A detected feature: which one, where the evidence is, and its per-target verdicts. */
export interface DetectedFeature {
  readonly id: FeatureId
  readonly label: string
  readonly evidence: readonly Evidence[]
  readonly verdicts: Readonly<Record<Target, Verdict>>
}

/** Line number (1-based) of a string index. */
const lineAt = (content: string, index: number): number =>
  content.slice(0, index).split("\n").length

// --- Detection signals (all matched against comment-stripped source so doc examples don't false-positive) ---

// A non-type import (static, side-effect, dynamic, or re-export) from one of these `@nifrajs/*` packages.
// Used to confirm a symbol like `MemoryStore` is the framework's, not a same-named local class.
const importsFrom = (code: string, pkg: string): boolean => {
  const escaped = pkg.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&")
  // `from "@nifrajs/x"` | `from "@nifrajs/x/sub"` | `import("@nifrajs/x")` | `import "@nifrajs/x"`
  const rx = new RegExp(`(?:from|import)\\s*\\(?\\s*["'\`]${escaped}(?:/[^"'\`]*)?["'\`]`)
  return rx.test(code)
}

// `new MemorySessionStore(` / `MemorySessionStore` referenced as a value. We require the @nifrajs/auth
// import in the same file (importsFrom) so a same-named user class never trips it.
const SESSION_STORE = /(?<![.\w$])MemorySessionStore\b/g
const ISR_CACHE = /(?<![.\w$])MemoryCacheStore\b/g
// Rate-limit store. The exported symbol is the generic `MemoryStore`; require the @nifrajs/middleware
// import so it can't collide with an unrelated `MemoryStore` from elsewhere.
const RATE_LIMIT = /(?<![.\w$])MemoryStore\b/g
// In-process cron: the scheduler factory. Paired with the @nifrajs/cron import.
const CRON_SCHEDULER = /(?<![.\w$])createScheduler\s*\(/g
// `.ws(` method call — a WebSocket route registration on a nifra app. `(?<![.\w$])` keeps it from
// matching identifiers that merely END in `ws` (e.g. `rows(`, `views(`). It DOES match `app.ws(`,
// `server().ws(`, `x.ws(` — all the chained forms — because the dot is consumed by the call, and the
// negative lookbehind only guards the char BEFORE `ws`, which is the dot here. We exclude the dot from
// the lookbehind set on purpose: a method call is exactly what we want.
const WS_ROUTE = /\.ws\s*\(/g
const WS_HUB = /(?<![.\w$])createWebSocketHub\b/
// `Bun.` / `Deno.` runtime globals. `(?<![.\w$])` rejects `myBun.x`, `globalThis.Bun` stays a real use
// (we want it), and `obj.Bun.` won't match because the char before `Bun` would be `.`.
const BUN_GLOBAL = /(?<![.\w$])Bun\s*\./g
const DENO_GLOBAL = /(?<![.\w$])Deno\s*\./g
// `node:` builtin specifier in any import/require/export-from form.
const NODE_BUILTIN = /(?:from|import|require)\s*\(?\s*["'`](node:[A-Za-z0-9/_-]+)["'`]/g

const pushHits = (
  out: Evidence[],
  file: string,
  content: string,
  code: string,
  rx: RegExp,
): void => {
  rx.lastIndex = 0
  const lines = content.split("\n")
  for (let m = rx.exec(code); m !== null; m = rx.exec(code)) {
    const line = lineAt(code, m.index)
    out.push({ file, line, snippet: (lines[line - 1] ?? "").trim() })
  }
}

/**
 * The per-file scan accumulator. Each feature's evidence is collected across the whole project before
 * the WS post-pass (in-process WS is only a hazard when NO `createWebSocketHub` exists anywhere).
 */
interface ScanState {
  readonly evidence: Map<FeatureId, Evidence[]>
  /** True once any file references `createWebSocketHub` — suppresses the in-process-websocket finding. */
  hasWebSocketHub: boolean
}

/**
 * Scan one file's source for every feature signal, mutating `state`. Pure w.r.t. the filesystem (takes
 * the already-read `content`). Comment- and template-literal-stripped first, so a usage example in a
 * doc comment or a code-as-text string never false-positives (shared with `nifra check`/`doctor`).
 */
export function scanFileForFeatures(file: string, content: string, state: ScanState): void {
  const code = stripComments(content)
  const add = (id: FeatureId): Evidence[] => {
    const list = state.evidence.get(id) ?? []
    if (!state.evidence.has(id)) state.evidence.set(id, list)
    return list
  }

  if (WS_HUB.test(code)) state.hasWebSocketHub = true

  if (importsFrom(code, "@nifrajs/auth"))
    pushHits(add("in-memory-session-store"), file, content, code, SESSION_STORE)
  if (importsFrom(code, "@nifrajs/web"))
    pushHits(add("in-memory-isr-cache"), file, content, code, ISR_CACHE)
  if (importsFrom(code, "@nifrajs/middleware"))
    pushHits(add("in-memory-rate-limit"), file, content, code, RATE_LIMIT)
  if (importsFrom(code, "@nifrajs/cron"))
    pushHits(add("in-process-cron"), file, content, code, CRON_SCHEDULER)
  // WS routes are collected unconditionally; the hub-presence post-pass decides whether they're a hazard.
  pushHits(add("in-process-websocket"), file, content, code, WS_ROUTE)
  pushHits(add("bun-runtime-api"), file, content, code, BUN_GLOBAL)
  pushHits(add("deno-runtime-api"), file, content, code, DENO_GLOBAL)
  pushHits(add("node-builtin"), file, content, code, NODE_BUILTIN)
}

// Mirror nifra check/doctor's ignore set: deps, build output, generated/per-runtime dist dirs, VCS.
// PLUS *.config.* and obvious build scripts (build*.ts) — `port` scans request/app source, not tooling.
const IGNORED =
  /(^|\/)(node_modules|dist(-[a-z0-9]+)?|build|\.nifra|\.git|\.wrangler|coverage)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)[^/]*\.config\.[cm]?[jt]sx?$|(^|\/)build[^/]*\.[cm]?[jt]sx?$/

/** Walk the project's source (same surface as `nifra check`, minus config + build scripts). */
async function walkPortSource(
  cwd: string,
  visit: (rel: string, content: string) => void,
): Promise<void> {
  for await (const rel of new Glob("**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}").scan({
    cwd,
    dot: false,
  })) {
    if (IGNORED.test(rel)) continue
    visit(rel, await Bun.file(join(cwd, rel)).text())
  }
}

const byEvidence = (a: Evidence, b: Evidence): number =>
  a.file.localeCompare(b.file) || a.line - b.line

/** Run every detector over the project and return the detected features (sorted, stable). */
export async function detectFeatures(cwd: string): Promise<DetectedFeature[]> {
  const state: ScanState = { evidence: new Map(), hasWebSocketHub: false }
  await walkPortSource(cwd, (rel, content) => scanFileForFeatures(rel, content, state))

  const detected: DetectedFeature[] = []
  for (const id of FEATURE_IDS) {
    const evidence = state.evidence.get(id)
    if (evidence === undefined || evidence.length === 0) continue
    // in-process WebSocket is only a portability hazard when the app does NOT use createWebSocketHub
    // (the Workers Durable Object hub) — its presence means the WS routes are already edge-ready.
    if (id === "in-process-websocket" && state.hasWebSocketHub) continue
    const spec = FEATURES[id]
    detected.push({
      id,
      label: spec.label,
      evidence: [...evidence].sort(byEvidence),
      verdicts: spec.verdicts,
    })
  }
  return detected
}

// --- Target auto-detection ----------------------------------------------------------------------------

export interface ResolvedTarget {
  readonly target: Target
  /** How the target was determined — surfaced so the report explains itself. */
  readonly source: "flag" | "package-json-build" | "package-json-deploy" | "wrangler" | "vercel"
}

const BUILD_SCRIPT_TARGET: ReadonlyArray<readonly [RegExp, Target]> = [
  // create-nifra's canonical per-target build scripts (build-bun.ts / build-node.ts / build-deno.ts /
  // build-vercel.ts), plus the bare `build.ts` the cf-pages preset uses.
  [/build-vercel\.[cm]?[jt]s\b/, "vercel"],
  [/build-deno\.[cm]?[jt]s\b/, "deno"],
  [/build-node\.[cm]?[jt]s\b/, "node"],
  [/build-bun\.[cm]?[jt]s\b/, "bun"],
]
const DEPLOY_SCRIPT_TARGET: ReadonlyArray<readonly [RegExp, Target]> = [
  [/\bvercel\s+deploy\b/, "vercel"],
  [/\bdeployctl\b/, "deno"],
  [/wrangler\s+pages\s+deploy\b/, "cf-pages"],
  [/\bdocker\s+build\b/, "node"],
]

interface PackageJsonScripts {
  readonly scripts?: Readonly<Record<string, string>>
}

/**
 * Resolve the app's deploy target. `--target` (validated) always wins. Otherwise infer it, in priority
 * order, from: the canonical `build` script (create-nifra's `build-<target>.ts`), the `deploy` script
 * (the vendor CLI it shells out to), a `wrangler.toml` (Cloudflare Pages), or a `vercel.json`. Returns
 * `undefined` when nothing signals a target (the matrix still prints; CI gating needs an explicit one).
 */
export async function resolveTarget(
  cwd: string,
  override?: string,
): Promise<ResolvedTarget | undefined> {
  if (override !== undefined) {
    if (!isTarget(override)) {
      throw new Error(`[nifra] invalid --target "${override}". options: ${TARGETS.join(", ")}`)
    }
    return { target: override, source: "flag" }
  }

  const pkg = await readJson<PackageJsonScripts>(join(cwd, "package.json"))
  const scripts = pkg?.scripts
  if (scripts !== undefined) {
    const build = scripts.build ?? ""
    for (const [rx, target] of BUILD_SCRIPT_TARGET) {
      if (rx.test(build)) return { target, source: "package-json-build" }
    }
    const deploy = scripts.deploy ?? ""
    for (const [rx, target] of DEPLOY_SCRIPT_TARGET) {
      if (rx.test(deploy)) return { target, source: "package-json-deploy" }
    }
  }

  if (await Bun.file(join(cwd, "wrangler.toml")).exists()) {
    return { target: "cf-pages", source: "wrangler" }
  }
  if (
    (await Bun.file(join(cwd, "vercel.json")).exists()) ||
    (await Bun.file(join(cwd, ".vercel", "project.json")).exists())
  ) {
    return { target: "vercel", source: "vercel" }
  }
  return undefined
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    const parsed = JSON.parse(await Bun.file(path).text()) as unknown
    return typeof parsed === "object" && parsed !== null ? (parsed as T) : undefined
  } catch {
    return undefined
  }
}

// --- Result shaping (the `--json` contract) -----------------------------------------------------------

/** One feature in the `--json` output: its id, evidence as `file:line` strings, and per-target verdicts. */
export interface PortJsonFeature {
  readonly id: FeatureId
  readonly label: string
  readonly evidence: readonly string[]
  readonly verdicts: Readonly<Record<Target, Verdict>>
}

/** One blocking finding: a detected feature unsupported on the resolved target, with its fix. */
export interface PortBlock {
  readonly feature: FeatureId
  readonly verdict: Extract<Verdict, "unsupported" | "caveat">
  readonly reason: string
  readonly evidence: readonly string[]
}

/** The stable machine-readable result `--json` prints. No `any`; every field is shaped. */
export interface PortJson {
  /** The resolved deploy target, or `null` when none could be determined and none was given. */
  readonly target: Target | null
  readonly targetSource: ResolvedTarget["source"] | null
  readonly features: readonly PortJsonFeature[]
  /** Findings that fail the gate (unsupported), plus caveats when `--strict`. Empty ⇒ portable. */
  readonly blocked: readonly PortBlock[]
  /** True when the app is portable to the resolved target (or to all targets when none is resolved). */
  readonly ok: boolean
}

const evidenceStrings = (evidence: readonly Evidence[]): string[] =>
  evidence.map((e) => `${e.file}:${e.line}`)

export interface PortResult {
  readonly resolved: ResolvedTarget | undefined
  readonly detected: readonly DetectedFeature[]
  readonly json: PortJson
}

/**
 * Compute the full `port` result: detect features, resolve the target, and derive the blocking findings.
 * A finding blocks when the detected feature is `unsupported` on the resolved target — always — and
 * (with `strict`) also when it's a `caveat`. With no resolved target there's nothing to gate against,
 * so `blocked` is empty and `ok` reflects "are there hazards at all" only when the caller asks.
 */
export async function collectPortResult(
  cwd: string,
  opts: { readonly target?: string; readonly strict?: boolean } = {},
): Promise<PortResult> {
  const [detected, resolved] = await Promise.all([
    detectFeatures(cwd),
    resolveTarget(cwd, opts.target),
  ])

  const blocked: PortBlock[] = []
  if (resolved !== undefined) {
    for (const feature of detected) {
      const verdict = feature.verdicts[resolved.target]
      const blocks = verdict === "unsupported" || (verdict === "caveat" && opts.strict === true)
      if (!blocks) continue
      blocked.push({
        feature: feature.id,
        verdict,
        reason: FEATURES[feature.id].reasons[resolved.target],
        evidence: evidenceStrings(feature.evidence),
      })
    }
  }

  const json: PortJson = {
    target: resolved?.target ?? null,
    targetSource: resolved?.source ?? null,
    features: detected.map((f) => ({
      id: f.id,
      label: f.label,
      evidence: evidenceStrings(f.evidence),
      verdicts: f.verdicts,
    })),
    blocked,
    ok: blocked.length === 0,
  }
  return { resolved, detected, json }
}

// --- Rendering ----------------------------------------------------------------------------------------

const CELL: Readonly<Record<Verdict, string>> = { ok: "✓", caveat: "⚠", unsupported: "✗" }
const COL_WIDTH = 9 // widest target header ("cf-pages") + padding

const padCell = (s: string, width: number): string => {
  // Pad accounting for the symbol's display width (✓/⚠/✗ render as 1 cell in a monospace terminal).
  const len = [...s].length
  return s + " ".repeat(Math.max(0, width - len))
}

/** Render the feature × target matrix + evidence + summary as a readable report. */
export function renderReport(result: PortResult, opts: { readonly strict?: boolean }): string {
  const { detected, resolved, json } = result
  const out: string[] = ["nifra port — portability matrix", ""]

  if (resolved !== undefined) {
    out.push(`target: ${resolved.target} (detected from ${describeSource(resolved.source)})`)
  } else {
    out.push(
      "target: not detected — pass --target <bun|node|deno|cf-pages|vercel> to gate against one",
    )
  }
  out.push("")

  if (detected.length === 0) {
    out.push("✓ no portability hazards detected — this app is portable across all targets.")
    return out.join("\n")
  }

  // Header row.
  const labelWidth = Math.max(22, ...detected.map((f) => f.label.length)) + 2
  const header = padCell("feature", labelWidth) + TARGETS.map((t) => padCell(t, COL_WIDTH)).join("")
  out.push(header)
  out.push("-".repeat(header.length))
  for (const feature of detected) {
    const cells = TARGETS.map((t) => padCell(CELL[feature.verdicts[t]], COL_WIDTH)).join("")
    out.push(padCell(feature.label, labelWidth) + cells)
  }
  out.push("")
  out.push("legend: ✓ ok   ⚠ caveat (works with a change)   ✗ unsupported")
  out.push("")

  // Evidence per detected feature.
  out.push("detected features + evidence:")
  for (const feature of detected) {
    out.push(`  • ${feature.label} (${feature.id})`)
    out.push(`      why: ${FEATURES[feature.id].summary}`)
    for (const e of feature.evidence) {
      out.push(`      ${e.file}:${e.line}  ${e.snippet}`)
    }
  }
  out.push("")

  // Summary + blocking detail.
  if (resolved === undefined) {
    out.push(
      `• ${detected.length} portability hazard(s) detected; no target resolved, so nothing is gated. ` +
        "Pass --target to check one.",
    )
    return out.join("\n")
  }

  if (json.blocked.length === 0) {
    // With the gate passing, surface any caveats for the resolved target so the user still sees the
    // "works, but with a change" cases (they don't fail without --strict, but they're not free either).
    const caveatHere = detected.filter((f) => f.verdicts[resolved.target] === "caveat")
    if (caveatHere.length === 0) {
      out.push(`✓ portable to ${resolved.target}: every detected feature is supported there.`)
    } else {
      out.push(
        `✓ no blockers for ${resolved.target}, but ${caveatHere.length} feature(s) need a change there:`,
      )
      for (const f of caveatHere) {
        out.push(`  ⚠ ${f.label} — ${FEATURES[f.id].reasons[resolved.target]}`)
      }
      out.push("\n(caveats don't fail the gate — run with --strict to treat them as blockers)")
    }
    return out.join("\n")
  }

  const unsupported = json.blocked.filter((b) => b.verdict === "unsupported")
  const caveats = json.blocked.filter((b) => b.verdict === "caveat")
  out.push(`✗ ${json.blocked.length} feature(s) block deploying to ${resolved.target}:`)
  for (const b of [...unsupported, ...caveats]) {
    const mark = b.verdict === "unsupported" ? "✗" : "⚠"
    out.push(`  ${mark} ${FEATURES[b.feature].label} — ${b.verdict} on ${resolved.target}`)
    out.push(`      fix: ${b.reason}`)
    out.push(`      at:  ${b.evidence.join(", ")}`)
  }
  if (!opts.strict && unsupported.length === 0) {
    out.push("\n(only caveats — run with --strict to fail on these)")
  }
  return out.join("\n")
}

function describeSource(source: ResolvedTarget["source"]): string {
  switch (source) {
    case "flag":
      return "--target"
    case "package-json-build":
      return "the package.json build script"
    case "package-json-deploy":
      return "the package.json deploy script"
    case "wrangler":
      return "wrangler.toml"
    case "vercel":
      return "vercel config"
  }
}

export interface RunPortOptions {
  readonly target?: string
  readonly json?: boolean
  /** Fail (exit non-zero) on a detected unsupported feature for the resolved target. Implied by --target. */
  readonly ci?: boolean
  /** With --ci, also fail on caveats (not just unsupported). */
  readonly strict?: boolean
}

/**
 * Run `nifra port`: detect, resolve, render. Returns `true` when the run "passes" — meaning either the
 * gate is off, or the gate is on and nothing blocks. The caller maps `false` → exit 1.
 *
 * The gate fires when `--ci` is passed OR a `--target` is set (an explicit target signals intent to
 * gate). With no resolved target and `--ci`, the run is a hard error: there's nothing to gate against.
 */
export async function runPort(cwd: string, opts: RunPortOptions = {}): Promise<boolean> {
  const result = await collectPortResult(cwd, {
    ...(opts.target !== undefined ? { target: opts.target } : {}),
    ...(opts.strict ? { strict: true } : {}),
  })
  // The gate is on when --ci or an explicit --target was given.
  const gating = opts.ci === true || opts.target !== undefined

  if (opts.json) {
    console.log(JSON.stringify(result.json, null, 2))
  } else {
    console.log(renderReport(result, { strict: opts.strict ?? false }))
  }

  if (!gating) return true
  if (result.resolved === undefined) {
    if (!opts.json) {
      console.error(
        "\n[nifra] --ci needs a deploy target to gate against, and none was detected. Pass --target <bun|node|deno|cf-pages|vercel>.",
      )
    }
    return false
  }
  return result.json.blocked.length === 0
}
