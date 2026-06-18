/**
 * Shared SSR benchmark harness — oha load, hydration payload accounting, server lifecycle.
 * Used by bench/ssr/run.ts (and kept aligned with prerender-ttfb.ts methodology).
 */

export const SSR_BENCH_HOST = "127.0.0.1"
export const SSR_BENCH_CONNECTIONS = 50
export const SSR_BENCH_DURATION_S = 5
export const SSR_BENCH_WARMUP_S = 3
export const SSR_BENCH_RUNS = 3
/** Extra requests before measuring ISR targets so oha hits a warm cache, not a cold render. */
export const SSR_BENCH_ISR_WARMUP_REQUESTS = 500

export interface SsrBenchTarget {
  readonly name: string
  readonly runtime: string
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
  readonly rootId: string
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
  const lat = field(json, "latencyPercentiles")
  const p50 = finiteNumber(field(lat, "p50"))
  const p99 = finiteNumber(field(lat, "p99"))
  if (rps === undefined || p50 === undefined || p99 === undefined || success === undefined) {
    throw new Error(`oha: unexpected JSON shape: ${raw.slice(0, 200)}`)
  }
  if (success < 0.99) {
    throw new Error(
      `oha: only ${(success * 100).toFixed(0)}% of requests succeeded — server shed load or refused connections`,
    )
  }
  return { rps: Math.round(rps), p50ms: p50 * 1000, p99ms: p99 * 1000 }
}

export async function runOha(url: string, durationS: number): Promise<SsrBenchMeasure> {
  const args = [
    "-c",
    String(SSR_BENCH_CONNECTIONS),
    "-z",
    `${durationS}s`,
    "--no-tui",
    "--output-format",
    "json",
    url,
  ]
  // oha 1.14+ rejects NO_COLOR=1 (common in CI) — its --no-color only accepts true/false literals.
  const env = { ...process.env }
  delete env.NO_COLOR
  delete env.CLERK_NO_COLOR
  const proc = Bun.spawn(["oha", ...args], { stdout: "pipe", stderr: "pipe", env })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`oha exited ${code}: ${err.slice(0, 200)}`)
  return parseOha(out)
}

export async function sampleMedian(url: string): Promise<SsrBenchMeasure> {
  const runs: SsrBenchMeasure[] = []
  for (let i = 0; i < SSR_BENCH_RUNS; i++) {
    runs.push(await runOha(url, SSR_BENCH_DURATION_S))
  }
  const sorted = [...runs].sort((a, b) => a.rps - b.rps)
  return sorted[sorted.length >> 1] ?? runs[0] ?? { rps: 0, p50ms: 0, p99ms: 0 }
}

/**
 * Client JS the page ships: fetch SSR HTML, sum every script src + modulepreload (raw + gzip).
 */
export async function measureHydrationPayload(
  html: string,
  base: string,
): Promise<{ raw: number; gzip: number }> {
  const srcs = new Set<string>()
  const add = (u: string | undefined): void => {
    if (u !== undefined) srcs.add(new URL(u, base).href)
  }
  for (const m of html.matchAll(/<script[^>]+src="([^"]+)"/g)) add(m[1])
  for (const m of html.matchAll(/<link\b[^>]*\bhref="([^"]+)"[^>]*>/g)) {
    const tag = m[0]
    const isScript =
      /rel="modulepreload"/.test(tag) || (/rel="preload"/.test(tag) && /as="script"/.test(tag))
    if (isScript) add(m[1])
  }
  let raw = 0
  let gzip = 0
  for (const url of srcs) {
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
}

export async function waitServerReady(base: string, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    try {
      const res = await fetch(base)
      if (res.ok) {
        await res.text()
        return
      }
    } catch {
      // booting — retry
    }
    await Bun.sleep(100)
  }
  throw new Error(`server at ${base} did not become ready within ${timeoutMs}ms`)
}

/** Prime framework / in-process caches so ISR measurements reflect steady-state hits. */
export async function warmupCacheHits(base: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const res = await fetch(base)
    if (!res.ok) throw new Error(`cache warmup failed: ${res.status} ${base}`)
    await res.text()
  }
}

export async function measureTarget(target: SsrBenchTarget): Promise<SsrBenchResult> {
  const base = `http://${SSR_BENCH_HOST}:${target.port}/`
  const build = Bun.spawn([...target.build], {
    stdout: "ignore",
    stderr: "inherit",
    ...(target.cwd !== undefined ? { cwd: target.cwd } : {}),
  })
  if ((await build.exited) !== 0) {
    throw new Error("build failed")
  }

  const proc = Bun.spawn([...target.serve], {
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
    await waitServerReady(base, 15_000)
    if (target.warmupCache === true) {
      await warmupCacheHits(base, SSR_BENCH_ISR_WARMUP_REQUESTS)
    }
    const html = await (await fetch(base)).text()
    validateSsrHtml(html, target)
    const payload = await measureHydrationPayload(html, base)
    await runOha(base, SSR_BENCH_WARMUP_S)
    const m = await sampleMedian(base)
    return { ...m, payloadRaw: payload.raw, payloadGzip: payload.gzip }
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

export function printResultRow(target: SsrBenchTarget, r: SsrBenchResult): void {
  console.log(
    `  ${target.name.padEnd(22)} [${target.runtime.padEnd(4)}]  ${r.rps.toLocaleString().padStart(7)} req/s   ` +
      `p50 ${r.p50ms.toFixed(2).padStart(6)}ms   p99 ${r.p99ms.toFixed(2).padStart(7)}ms   ` +
      `JS ${formatKb(r.payloadRaw).padStart(9)} (${formatKb(r.payloadGzip)} gz)`,
  )
}
