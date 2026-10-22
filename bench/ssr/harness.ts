/**
 * Shared SSR benchmark harness - oha load, hydration payload accounting, server lifecycle.
 * Used by bench/ssr/run.ts (and kept aligned with prerender-ttfb.ts methodology).
 */
import { cpuListFromEnv, pinned } from "../pinning.ts"

// Shares the HTTP bench's env knobs so ONE preset speeds both: `BENCH_DURATION_S=2 BENCH_WARMUP_S=1
// BENCH_ROUNDS=1 …`. Defaults are the credible-numbers set used for the published tables.
const envInt = (name: string, dflt: number, min = 1): number => {
  const n = Bun.env[name] === undefined ? Number.NaN : Number(Bun.env[name])
  return Number.isInteger(n) && n >= min ? n : dflt
}
export const SSR_BENCH_HOST = "127.0.0.1"
export const SSR_BENCH_CONNECTIONS = envInt("BENCH_CONNS", 50)
export const SSR_BENCH_DURATION_S = envInt("BENCH_DURATION_S", 5)
export const SSR_BENCH_WARMUP_S = envInt("BENCH_WARMUP_S", 3, 0)
/** Interleaved rounds per table: every target is measured once per round, in a rotated order. */
export const SSR_BENCH_ROUNDS = envInt("BENCH_ROUNDS", 5)
/** Where round 0 starts in the rotation; a CI job advances it per run (bench/rounds.ts). */
export const SSR_BENCH_ROUND_OFFSET = envInt("BENCH_ROUND_OFFSET", 0, 0)
const SERVER_CPUS = cpuListFromEnv("BENCH_SERVER_CPUS")
const LOAD_CPUS = cpuListFromEnv("BENCH_LOAD_CPUS")
/** Extra requests before measuring ISR targets so oha hits a warm cache, not a cold render. */
export const SSR_BENCH_ISR_WARMUP_REQUESTS = 500

/**
 * Headers on every request the bench makes to a row. oha otherwise sends `accept-encoding: gzip,
 * compress, deflate, br`, and only some frameworks compress by default (Next.js gzips, React
 * Router brotli-compresses), so rows would pay unequal per-request compression costs.
 */
export const SSR_BENCH_REQUEST_HEADERS: Readonly<Record<string, string>> = {
  "accept-encoding": "identity",
}

/** {@link SSR_BENCH_REQUEST_HEADERS} as oha `-H` arguments. */
export const SSR_BENCH_OHA_HEADER_ARGS: readonly string[] = Object.entries(
  SSR_BENCH_REQUEST_HEADERS,
).flatMap(([name, value]) => ["-H", `${name}: ${value}`])

/** Throw when a response was encoded although the bench's request headers asked for identity. */
export function assertUncompressed(headers: Headers): void {
  const encoding = headers.get("content-encoding")
  if (encoding === null || encoding.trim().toLowerCase() === "identity") return
  throw new Error(
    `response is ${JSON.stringify(encoding)}-encoded under accept-encoding: ${SSR_BENCH_REQUEST_HEADERS["accept-encoding"]}, so the row would not be measured uncompressed`,
  )
}

/** The page every sample measures, fetched with the bench's headers and checked uncompressed. */
export async function fetchBenchPage(base: string): Promise<{ html: string; link: string | null }> {
  const res = await fetch(base, { headers: SSR_BENCH_REQUEST_HEADERS })
  const html = await res.text()
  assertUncompressed(res.headers)
  return { html, link: res.headers.get("link") }
}

/**
 * What a row measures (bench/ssr/README.md). Only `app` rows are like for like with each other.
 * - `app`: a framework app built and served the way that framework ships it.
 * - `renderer`: a UI library's own render-to-string on a bare server, no framework. Published only
 *   where no meta-framework exists to compare with (Preact), and never a headline.
 * - `static-host`: prerendered files from a plain file server, no framework code per request.
 */
export type SsrRowKind = "app" | "renderer" | "static-host"

export interface SsrBenchTarget {
  readonly name: string
  readonly runtime: "bun" | "node"
  /** Defaults to `app`. */
  readonly kind?: SsrRowKind
  readonly build: readonly string[]
  readonly serve: readonly string[]
  readonly cwd?: string
  readonly port: number
  /** Validate rendered HTML before measuring so a broken SSR bundle cannot report req/s. */
  readonly validate?: SsrHtmlValidation
  /** Extra env for the serve subprocess (e.g. DIST for the static file server). */
  readonly serveEnv?: Readonly<Record<string, string>>
  /** Prime an in-memory / framework cache before oha (ISR rows). */
  readonly warmupCache?: boolean
}

export interface SsrHtmlValidation {
  /** Hydration root div to scope the checks to. Omit for frameworks without a fixed root id
   * (Next/Remix/Nuxt/SvelteKit/SolidStart) - the whole document is checked instead. */
  readonly rootId?: string
  readonly text: string
  readonly liCount: number
}

export interface SsrBenchMeasure {
  readonly rps: number
  readonly p50ms: number
  readonly p99ms: number
}

export interface SsrBenchResult extends SsrBenchMeasure {
  readonly payloadRaw: number
  readonly payloadGzip: number
}

export const SSR_BENCH_ZERO: SsrBenchResult = {
  rps: 0,
  p50ms: 0,
  p99ms: 0,
  payloadRaw: 0,
  payloadGzip: 0,
}

function finiteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

function field(obj: unknown, key: string): unknown {
  return typeof obj === "object" && obj !== null && key in obj
    ? (obj as Record<string, unknown>)[key]
    : undefined
}

/** Parse oha JSON at the trust boundary; reject runs that didn't (almost) fully succeed. */
export function parseOha(raw: string): SsrBenchMeasure {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new Error(`oha: output was not JSON: ${raw.slice(0, 160)}`)
  }
  const summary = field(json, "summary")
  const rps = finiteNumber(field(summary, "requestsPerSec"))
  const success = finiteNumber(field(summary, "successRate"))
  const statuses = field(json, "statusCodeDistribution")
  const okRequests = finiteNumber(field(statuses, "200"))
  const lat = field(json, "latencyPercentiles")
  const p50 = finiteNumber(field(lat, "p50"))
  const p99 = finiteNumber(field(lat, "p99"))
  if (
    rps === undefined ||
    p50 === undefined ||
    p99 === undefined ||
    success === undefined ||
    okRequests === undefined
  ) {
    throw new Error(`oha: unexpected JSON shape: ${raw.slice(0, 200)}`)
  }
  const otherStatuses =
    typeof statuses === "object" &&
    statuses !== null &&
    Object.keys(statuses).some((status) => status !== "200" && field(statuses, status) !== 0)
  if (success !== 1 || okRequests <= 0 || otherStatuses) {
    throw new Error(
      `oha: invalid sample (successRate=${success}, HTTP 200=${okRequests}, other statuses=${otherStatuses})`,
    )
  }
  return { rps: Math.round(rps), p50ms: p50 * 1000, p99ms: p99 * 1000 }
}

let ohaSampleIndex = 0

export function ohaArgs(url: string, durationS: number): string[] {
  return [
    "-c",
    String(SSR_BENCH_CONNECTIONS),
    "-z",
    `${durationS}s`,
    "--wait-ongoing-requests-after-deadline",
    "--no-tui",
    "--output-format",
    "json",
    ...SSR_BENCH_OHA_HEADER_ARGS,
    url,
  ]
}

export async function runOha(url: string, durationS: number): Promise<SsrBenchMeasure> {
  // oha 1.14+ rejects NO_COLOR=1 (common in CI) - its --no-color only accepts true/false literals.
  const env = { ...process.env }
  delete env.NO_COLOR
  delete env.CLERK_NO_COLOR
  const proc = Bun.spawn(pinned(["oha", ...ohaArgs(url, durationS)], LOAD_CPUS), {
    stdout: "pipe",
    stderr: "pipe",
    env,
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const rawDir = Bun.env.BENCH_SSR_RAW_DIR
  if (rawDir !== undefined) {
    const filename = `${String(++ohaSampleIndex).padStart(4, "0")}-${new URL(url).port}-${durationS}s.json`
    await Bun.write(`${rawDir}/${filename}`, out, { createPath: true })
  }
  if (code !== 0) throw new Error(`oha exited ${code}: ${err.slice(0, 200)}`)
  return parseOha(out)
}

const isScriptPreload = (attrs: string): boolean =>
  /\brel="?modulepreload\b/.test(attrs) ||
  (/\brel="?preload\b/.test(attrs) && /\bas="?script\b/.test(attrs))

/**
 * Every client script a page loads: script src, script preload links, and the `Link` response
 * header. SvelteKit writes its modulepreloads only to that header unless it is prerendering, and
 * boots through an inline `import()`, so its HTML alone names no script.
 */
export function clientScriptUrls(html: string, base: string, linkHeader: string | null): string[] {
  const srcs = new Set<string>()
  const add = (u: string | undefined): void => {
    if (u !== undefined) srcs.add(new URL(u, base).href)
  }
  for (const m of html.matchAll(/<script[^>]+src="([^"]+)"/g)) add(m[1])
  for (const m of html.matchAll(/<link\b[^>]*\bhref="([^"]+)"[^>]*>/g)) {
    if (isScriptPreload(m[0])) add(m[1])
  }
  for (const m of (linkHeader ?? "").matchAll(/<([^>]+)>([^<]*)/g)) {
    if (isScriptPreload(m[2] ?? "")) add(m[1])
  }
  return [...srcs]
}

/** Client JS the page ships, raw + gzip, summed over {@link clientScriptUrls}. */
export async function measureHydrationPayload(
  html: string,
  base: string,
  linkHeader: string | null,
): Promise<{ raw: number; gzip: number }> {
  let raw = 0
  let gzip = 0
  for (const url of clientScriptUrls(html, base, linkHeader)) {
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer())
    raw += bytes.byteLength
    gzip += Bun.gzipSync(bytes).byteLength
  }
  return { raw, gzip }
}

function renderedRoot(html: string, rootId: string): string {
  const open = `<div id="${rootId}">`
  const start = html.indexOf(open)
  if (start < 0) throw new Error(`html validation failed: missing #${rootId}`)
  const bodyStart = start + open.length
  const tag = /<\/?div\b/g
  tag.lastIndex = bodyStart
  let depth = 1
  for (let match = tag.exec(html); match !== null; match = tag.exec(html)) {
    depth += match[0][1] === "/" ? -1 : 1
    if (depth === 0) return html.slice(bodyStart, match.index)
  }
  throw new Error(`html validation failed: #${rootId} is not closed`)
}

export function validateSsrHtml(html: string, target: SsrBenchTarget): void {
  const spec = target.validate
  if (spec === undefined) return
  if (spec.rootId !== undefined) {
    const root = renderedRoot(html, spec.rootId)
    const trimmed = root.trim()
    if (trimmed === "" || trimmed === "undefined" || trimmed === "null") {
      throw new Error(`html validation failed: #${spec.rootId} rendered ${JSON.stringify(trimmed)}`)
    }
    if (!root.includes(spec.text)) {
      throw new Error(
        `html validation failed: #${spec.rootId} is missing ${JSON.stringify(spec.text)}`,
      )
    }
    const liCount = root.match(/<li\b/g)?.length ?? 0
    if (liCount !== spec.liCount) {
      throw new Error(
        `html validation failed: #${spec.rootId} has ${liCount} <li> nodes, expected ${spec.liCount}`,
      )
    }
    return
  }
  // Root-less document check: every comparator must prove it server-rendered the same catalog, not
  // an empty shell. `>=` rather than `===` because meta-frameworks also serialize the items into
  // their hydration payload, which can repeat `<li` outside the rendered markup.
  if (!html.includes(spec.text)) {
    throw new Error(`html validation failed: document is missing ${JSON.stringify(spec.text)}`)
  }
  const liCount = html.match(/<li\b/g)?.length ?? 0
  if (liCount < spec.liCount) {
    throw new Error(
      `html validation failed: document has ${liCount} <li> nodes, expected at least ${spec.liCount}`,
    )
  }
}

export async function waitServerReady(
  base: string,
  timeoutMs: number,
  childExitCode: () => number | null,
): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    const exited = childExitCode()
    if (exited !== null) throw new Error(`server exited before ready (exit code ${exited})`)
    try {
      const res = await fetch(base)
      if (res.ok) {
        await res.text()
        const exitedAfterResponse = childExitCode()
        if (exitedAfterResponse !== null) {
          throw new Error(`server exited before ready (exit code ${exitedAfterResponse})`)
        }
        return
      }
    } catch {
      // booting - retry
    }
    await Bun.sleep(100)
  }
  throw new Error(`server at ${base} did not become ready within ${timeoutMs}ms`)
}

/** Prime framework / in-process caches so ISR measurements reflect steady-state hits. */
export async function warmupCacheHits(base: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const res = await fetch(base, { headers: SSR_BENCH_REQUEST_HEADERS })
    if (!res.ok) throw new Error(`cache warmup failed: ${res.status} ${base}`)
    await res.text()
  }
}

export function rowKind(target: SsrBenchTarget): SsrRowKind {
  return target.kind ?? "app"
}

export { median, pairedRatio, roundOrder } from "../rounds.ts"

export async function buildTarget(target: SsrBenchTarget): Promise<void> {
  // Capture build stderr and surface it only on failure: comparator builds emit cosmetic warnings
  // (rollup treeshake notices, empty-chunk messages) that would otherwise interleave with the
  // result tables, while a failing build still prints everything it said.
  const build = Bun.spawn([...target.build], {
    stdout: "ignore",
    stderr: "pipe",
    ...(target.cwd !== undefined ? { cwd: target.cwd } : {}),
  })
  const buildStderr = new Response(build.stderr).text()
  if ((await build.exited) !== 0) {
    process.stderr.write(await buildStderr)
    throw new Error("build failed")
  }
}

/** One sample of a built target: a fresh server process, validated HTML, warmup, one oha window. */
export async function measureOnce(
  target: SsrBenchTarget,
  withPayload: boolean,
): Promise<SsrBenchMeasure & { readonly payload?: { raw: number; gzip: number } }> {
  const base = `http://${SSR_BENCH_HOST}:${target.port}/`
  const proc = Bun.spawn(pinned(target.serve, SERVER_CPUS), {
    stdout: "ignore",
    stderr: "inherit",
    env: {
      ...process.env,
      PORT: String(target.port),
      ...target.serveEnv,
    },
    ...(target.cwd !== undefined ? { cwd: target.cwd } : {}),
  })

  try {
    await waitServerReady(base, 15_000, () => proc.exitCode)
    if (target.warmupCache === true) {
      await warmupCacheHits(base, SSR_BENCH_ISR_WARMUP_REQUESTS)
    }
    const { html, link } = await fetchBenchPage(base)
    validateSsrHtml(html, target)
    const payload = withPayload ? await measureHydrationPayload(html, base, link) : undefined
    await runOha(base, SSR_BENCH_WARMUP_S)
    const m = await runOha(base, SSR_BENCH_DURATION_S)
    return payload === undefined ? m : { ...m, payload }
  } finally {
    proc.kill()
    await proc.exited
  }
}

export function formatKb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`
}

export function nodeVersion(): string {
  try {
    const r = Bun.spawnSync(["node", "--version"])
    return r.success ? new TextDecoder().decode(r.stdout).trim() : "?"
  } catch {
    return "?"
  }
}

export function formatResultRow(target: SsrBenchTarget, r: SsrBenchResult, ratio: string): string {
  return (
    `  ${target.name.padEnd(38)} [${target.runtime.padEnd(4)}]  ${r.rps.toLocaleString().padStart(7)} req/s   ` +
    `p50 ${r.p50ms.toFixed(2).padStart(6)}ms   p99 ${r.p99ms.toFixed(2).padStart(7)}ms   ` +
    `JS ${formatKb(r.payloadGzip).padStart(8)} gz   ${ratio}`
  )
}
