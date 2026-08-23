/**
 * Route-count and stage-shape feedback loop for the general request pipeline.
 *
 * Each row runs in a fresh Bun process. The worker measures the same route twice: directly through
 * app.fetch (core-only) and through a real Bun TCP listener (network). The correctness probe runs
 * before either timed load, and every loaded response is consumed and checked, so a rejected or
 * partial row cannot become a plausible throughput number.
 *
 *   bun run bench/http/route-count.ts --check
 *   ROUTE_COUNT_REQUESTS=5000 bun run bench/http/route-count.ts
 */
import { server } from "../../packages/core/dist/server.js"
import type {
  StandardResult,
  StandardSchemaV1,
  StandardTypes,
} from "../../packages/core/src/index.ts"

const COUNTS = [1, 10, 50, 200] as const
const SHAPES = ["static", "dynamic", "query", "body", "lifecycle"] as const
type Shape = (typeof SHAPES)[number]

const envInt = (name: string, fallback: number, minimum = 1): number => {
  const value = Number(Bun.env[name])
  return Number.isInteger(value) && value >= minimum ? value : fallback
}

const CORE_REQUESTS = envInt("ROUTE_COUNT_CORE_REQUESTS", 2_000)
const NETWORK_REQUESTS = envInt("ROUTE_COUNT_NETWORK_REQUESTS", 1_000)
const NETWORK_CONCURRENCY = envInt("ROUTE_COUNT_NETWORK_CONCURRENCY", 16)
const WARMUP = envInt("ROUTE_COUNT_WARMUP", 100, 0)
const CHECK = process.argv.includes("--check")
const WORKER = process.argv.includes("--worker")

const querySchema: StandardSchemaV1<unknown, { q: string }> = {
  "~standard": {
    version: 1,
    vendor: "nifra-route-count-bench",
    validate(value): StandardResult<{ q: string }> {
      return typeof value === "object" &&
        value !== null &&
        "q" in value &&
        typeof value.q === "string"
        ? { value: { q: value.q } }
        : { issues: [{ message: "expected q:string" }] }
    },
    types: undefined as unknown as StandardTypes<unknown, { q: string }>,
  },
}

const bodySchema: StandardSchemaV1<unknown, { value: string }> = {
  "~standard": {
    version: 1,
    vendor: "nifra-route-count-bench",
    validate(value): StandardResult<{ value: string }> {
      return typeof value === "object" &&
        value !== null &&
        "value" in value &&
        typeof value.value === "string"
        ? { value: { value: value.value } }
        : { issues: [{ message: "expected value:string" }] }
    },
    types: undefined as unknown as StandardTypes<unknown, { value: string }>,
  },
}

type BenchApp = ReturnType<typeof server>

function addRoute(app: BenchApp, method: string, path: string, ...args: unknown[]): void {
  // Benchmark route construction is intentionally runtime-shaped; the production API remains fully
  // typed and this file only measures the resulting registered route graph.
  const register = (app as unknown as Record<string, (...values: unknown[]) => unknown>)[method]
  if (typeof register !== "function") throw new Error(`unsupported benchmark method ${method}`)
  register.call(app, path, ...args)
}

function makeApp(count: number, shape: Shape): BenchApp {
  if (!Number.isInteger(count) || count < 1) throw new Error(`invalid route count ${count}`)
  const app = server()
  if (shape === "lifecycle") {
    ;(app as unknown as { derive: (fn: (ctx: unknown) => object) => unknown }).derive(() => ({
      bench: true,
    }))
    ;(app as unknown as { beforeHandle: (fn: () => undefined) => unknown }).beforeHandle(
      () => undefined,
    )
    ;(app as unknown as { afterHandle: (fn: (value: unknown) => unknown) => unknown }).afterHandle(
      (value) => value,
    )
  }

  const targetPath = `/bench/${shape}`
  if (shape === "static") {
    addRoute(app, "get", targetPath, () => ({ shape, value: "ok" }))
  } else if (shape === "dynamic") {
    addRoute(app, "get", `${targetPath}/:id`, (ctx: { params: { id: string } }) => ({
      shape,
      value: ctx.params.id,
    }))
  } else if (shape === "query") {
    addRoute(app, "get", targetPath, { query: querySchema }, (ctx: { query: { q: string } }) => ({
      shape,
      value: ctx.query.q,
    }))
  } else if (shape === "body") {
    addRoute(app, "post", targetPath, { body: bodySchema }, (ctx: { body: { value: string } }) => ({
      shape,
      value: ctx.body.value,
    }))
  } else {
    addRoute(app, "get", targetPath, () => ({ shape, value: "ok" }))
  }

  for (let i = 1; i < count; i++) {
    addRoute(app, "get", `/bench/filler/${shape}/${i}`, () => ({ filler: i }))
  }
  return app
}

interface Measure {
  readonly routeCount: number
  readonly shape: Shape
  readonly mode: "core" | "network"
  readonly requests: number
  readonly concurrency: number
  readonly runtime: string
  readonly medianMs: number
  readonly p50Ms: number
  readonly p99Ms: number
  readonly successRate: number
}

interface ResponseCheck {
  readonly ok: boolean
  readonly status: number
  readonly shape?: unknown
  readonly value?: unknown
}

function requestFor(shape: Shape, base: string): Request {
  const path = shape === "dynamic" ? "/bench/dynamic/123" : `/bench/${shape}`
  if (shape === "query") return new Request(`${base}${path}?q=ada`)
  if (shape === "body") {
    return new Request(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "ada" }),
    })
  }
  return new Request(`${base}${path}`)
}

async function inspectResponse(response: Response, shape: Shape): Promise<ResponseCheck> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { ok: false, status: response.status }
  }
  const expected =
    shape === "dynamic" ? "123" : shape === "query" || shape === "body" ? "ada" : "ok"
  return {
    ok:
      response.status === 200 &&
      typeof body === "object" &&
      body !== null &&
      (body as Record<string, unknown>).shape === shape &&
      (body as Record<string, unknown>).value === expected,
    status: response.status,
    shape:
      typeof body === "object" && body !== null
        ? (body as Record<string, unknown>).shape
        : undefined,
    value:
      typeof body === "object" && body !== null
        ? (body as Record<string, unknown>).value
        : undefined,
  }
}

async function correctnessProbe(
  makeRequest: () => Request,
  fetcher: (request: Request) => Response | Promise<Response>,
  shape: Shape,
  label: string,
): Promise<void> {
  const result = await inspectResponse(await fetcher(makeRequest()), shape)
  if (!result.ok) {
    throw new Error(
      `${label}: correctness probe failed (${result.status}, ${String(result.shape)}, ${String(result.value)})`,
    )
  }
}

async function measure(
  app: BenchApp,
  count: number,
  shape: Shape,
  mode: "core" | "network",
): Promise<Measure> {
  let running: ReturnType<typeof Bun.serve> | undefined
  let base = "http://core"
  let fetcher: (request: Request) => Response | Promise<Response>
  if (mode === "network") {
    running = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => app.fetch(request),
    })
    base = `http://127.0.0.1:${running.port}`
    fetcher = (request) => fetch(request)
  } else {
    fetcher = (request) => app.fetch(request)
  }

  try {
    const makeRequest = () => requestFor(shape, base)
    await correctnessProbe(makeRequest, fetcher, shape, `${mode}/${count}/${shape}`)
    const warmup = Math.min(WARMUP, mode === "core" ? CORE_REQUESTS : NETWORK_REQUESTS)
    for (let i = 0; i < warmup; i++) {
      const result = await inspectResponse(await fetcher(makeRequest()), shape)
      if (!result.ok) throw new Error(`${mode}/${count}/${shape}: warmup response failed`)
    }

    const total = mode === "core" ? CORE_REQUESTS : NETWORK_REQUESTS
    const concurrency = mode === "core" ? 1 : Math.min(NETWORK_CONCURRENCY, total)
    const samples = new Float64Array(total)
    let next = 0
    let successes = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++
        if (index >= total) return
        const started = performance.now()
        try {
          const result = await inspectResponse(await fetcher(makeRequest()), shape)
          if (result.ok) successes++
        } catch {
          // Count the failed request and retain its elapsed time. It cannot become a success row.
        }
        samples[index] = performance.now() - started
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker))
    const sorted = Array.from(samples).sort((a, b) => a - b)
    const percentile = (fraction: number): number =>
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0
    return {
      routeCount: count,
      shape,
      mode,
      requests: total,
      concurrency,
      runtime: `Bun ${Bun.version}`,
      medianMs: percentile(0.5),
      p50Ms: percentile(0.5),
      p99Ms: percentile(0.99),
      successRate: successes / total,
    }
  } finally {
    running?.stop(true)
  }
}

async function worker(): Promise<void> {
  const count = Number(process.argv[process.argv.indexOf("--worker") + 1])
  const shape = process.argv[process.argv.indexOf("--worker") + 2] as Shape
  if (!COUNTS.includes(count as (typeof COUNTS)[number]) || !SHAPES.includes(shape)) {
    throw new Error(`invalid worker row ${count}/${shape}`)
  }
  const app = makeApp(count, shape)
  const rows = [
    await measure(app, count, shape, "core"),
    await measure(app, count, shape, "network"),
  ]
  console.log(JSON.stringify({ rows }))
}

async function run(): Promise<void> {
  const rows: Measure[] = []
  for (const count of COUNTS) {
    for (const shape of SHAPES) {
      const proc = Bun.spawn(["bun", import.meta.path, "--worker", String(count), shape], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      if (code !== 0)
        throw new Error(`route-count ${count}/${shape} failed: ${stderr.slice(0, 500)}`)
      let parsed: unknown
      try {
        parsed = JSON.parse(stdout.trim())
      } catch {
        throw new Error(
          `route-count ${count}/${shape} returned invalid JSON: ${stdout.slice(0, 300)}`,
        )
      }
      const workerRows = (parsed as { rows?: unknown }).rows
      if (!Array.isArray(workerRows) || workerRows.length !== 2)
        throw new Error(`route-count ${count}/${shape} returned incomplete rows`)
      rows.push(...(workerRows as Measure[]))
    }
  }

  console.log("\nRoute-count matrix - fresh Bun process per row")
  console.log(
    "route count | shape      | mode    | requests | concurrency | median/p50 ms | p99 ms | success",
  )
  for (const row of rows) {
    console.log(
      `${String(row.routeCount).padStart(11)} | ${row.shape.padEnd(10)} | ${row.mode.padEnd(7)} | ${String(row.requests).padStart(8)} | ${String(row.concurrency).padStart(11)} | ${row.medianMs.toFixed(3).padStart(13)} | ${row.p99Ms.toFixed(3).padStart(6)} | ${(row.successRate * 100).toFixed(1)}%`,
    )
  }
  if (CHECK) {
    const invalid = rows.filter((row) => row.successRate !== 1 || !Number.isFinite(row.p99Ms))
    if (invalid.length > 0)
      throw new Error(
        `route-count correctness gate failed for ${invalid.map((row) => `${row.routeCount}/${row.shape}/${row.mode}`).join(", ")}`,
      )
    console.log("route-count correctness gate passed (100% success across all rows)")
  }
}

if (WORKER) await worker()
else await run()
