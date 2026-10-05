/**
 * In-process `app.fetch()` cost of the OTel SDK bridge's `around()` plugin - no network, so it isolates
 * the per-request frame (one AsyncLocalStorage run plus a context object). Paired, order-alternating
 * rounds; the median paired delta is the overhead. Runs on Bun and on Node (Node loads the built dist:
 * `bun run build && bun run scripts/link-for-node.ts`).
 *
 *   bun bench/otel/bridge-fetch.ts
 *   node bench/otel/bridge-fetch.ts
 */
import { createRequire } from "node:module"
import { server } from "@nifrajs/core"
import { tracing } from "@nifrajs/otel"
import { type OtelApi, otelBridge } from "@nifrajs/otel/sdk-bridge"

type App = { fetch(request: Request): Response | Promise<Response> }

const ROUNDS = 41
const REQUESTS_PER_ROUND = 4_000

// The OTel packages are @nifrajs/otel's test devDependencies, so resolve them from there.
const require = createRequire(new URL("../../packages/otel/package.json", import.meta.url))
// biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: require() is untyped; this resolves @opentelemetry/api from packages/otel, and packages/otel/test/sdk-bridge.test.ts type-checks that module as an OtelApi.
const api = require("@opentelemetry/api") as OtelApi & {
  context: { setGlobalContextManager(manager: unknown): boolean }
}
// biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: require() is untyped; this resolves @opentelemetry/context-async-hooks ^2.11 from packages/otel, which exports this class with enable().
const { AsyncLocalStorageContextManager } = require("@opentelemetry/context-async-hooks") as {
  AsyncLocalStorageContextManager: new () => { enable(): unknown }
}
api.context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())

const noop = { onEnd() {} }
const handler = (c: { params: { id: string } }) => ({ id: c.params.id })
const variants: Array<{ label: string; app: App }> = [
  { label: "bare route", app: server().get("/users/:id", handler) },
  {
    label: "bare + bridge.plugin",
    app: server().use(otelBridge({ api }).plugin).get("/users/:id", handler),
  },
  {
    label: "tracing()",
    app: server()
      .use(tracing({ exporter: noop }))
      .get("/users/:id", handler),
  },
  {
    label: "tracing() + bridge.plugin",
    app: server()
      .use(tracing({ exporter: noop }))
      .use(otelBridge({ api }).plugin)
      .get("/users/:id", handler),
  },
]

const nowNs = (): number => Number(process.hrtime.bigint())
const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

async function round(app: App): Promise<number> {
  const request = new Request("http://nifra.test/users/42")
  const start = nowNs()
  for (let i = 0; i < REQUESTS_PER_ROUND; i++) await (await app.fetch(request)).text()
  return (nowNs() - start) / REQUESTS_PER_ROUND
}

for (const variant of variants) for (let i = 0; i < 3; i++) await round(variant.app)
const samples = variants.map((): number[] => [])
for (let r = 0; r < ROUNDS; r++) {
  for (let i = 0; i < variants.length; i++) {
    const index = (i + r) % variants.length
    const variant = variants[index]
    if (variant !== undefined) samples[index]?.push(await round(variant.app))
  }
}

const runtime =
  process.versions.bun === undefined ? `Node ${process.version}` : `Bun ${process.versions.bun}`
console.log(`\n  app.fetch() with and without bridge.plugin - ${runtime}\n`)
const pairs: Array<[number, number]> = [
  [0, 1],
  [2, 3],
]
for (const [without, withBridge] of pairs) {
  const a = samples[without] ?? []
  const b = samples[withBridge] ?? []
  const delta = median(b.map((ns, r) => ns - (a[r] ?? ns)))
  for (const index of [without, withBridge]) {
    console.log(
      `  ${(variants[index]?.label ?? "").padEnd(28)} ${median(samples[index] ?? [])
        .toFixed(0)
        .padStart(7)} ns/req`,
    )
  }
  console.log(
    `  ${"  paired overhead".padEnd(28)} ${delta.toFixed(0).padStart(7)} ns/req (${((delta / median(a)) * 100).toFixed(1)}%)\n`,
  )
}
