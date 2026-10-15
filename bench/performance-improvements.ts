/** Paired, alternating source-checkout comparisons. Results are local artifacts, never publication data. */
import { strict as assert } from "node:assert"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { availableParallelism } from "node:os"
import { join, resolve } from "node:path"
import { gzipSync } from "node:zlib"
import { compileSchema } from "../packages/schema/src/compile.ts"
import { t } from "../packages/schema/src/index.ts"
import type { CreateWebAppOptions } from "../packages/web/src/internal/web-app.ts"
import { buildManifest, type RouteModule } from "../packages/web/src/manifest.ts"
import { performanceHost } from "./performance-host.ts"

const args = process.argv.slice(2)
const argument = (name: string): string | undefined => {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}
const baselineArgument = argument("--baseline")
if (baselineArgument === undefined)
  throw new Error(
    "usage: performance-improvements.ts --baseline <original-checkout> [--check] [--output <file>]",
  )
const baseline = resolve(baselineArgument)
const current = resolve(import.meta.dir, "..")
if (baseline === current) throw new Error("baseline and current checkout must differ")
const CHECK = args.includes("--check")
const loads: number[] = []
function host(): void {
  const { load } = performanceHost(CHECK)
  loads.push(load)
}
host()

const baselineGuard: typeof import("../packages/web/src/internal/output-guard.ts") = await import(
  join(baseline, "packages/web/src/internal/output-guard.ts")
)
const currentGuard = await import("../packages/web/src/internal/output-guard.ts")
const baselineCache: typeof import("../packages/cache/src/index.ts") = await import(
  join(baseline, "packages/cache/src/index.ts")
)
const currentCache = await import("../packages/cache/src/index.ts")
const baselineTracing: typeof import("../packages/otel/src/cache.ts") = await import(
  join(baseline, "packages/otel/src/cache.ts")
)
const currentTracing = await import("../packages/otel/src/cache.ts")
const baselineWeb: typeof import("../packages/web/src/internal/web-app.ts") = await import(
  join(baseline, "packages/web/src/internal/web-app.ts")
)
const currentWeb = await import("../packages/web/src/internal/web-app.ts")
const baselineSchema: typeof import("../packages/schema/src/adapter.ts") = await import(
  join(baseline, "packages/schema/src/adapter.ts")
)

interface Measurement {
  readonly name: string
  readonly unit: "ns/op" | "bytes gzip"
  readonly before: number
  readonly after: number
  readonly improvementPercent: number
  readonly rounds: number
}
const results: Measurement[] = []
const median = (values: number[]): number =>
  values.sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0
type Operation = () => unknown
async function paired(
  name: string,
  before: Operation,
  after: Operation,
  asynchronous = false,
  batch = 10000,
): Promise<void> {
  const operations = [before, after]
  const samples: number[][] = [[], []]
  const ratios: number[] = []
  const warmup = Math.max(batch, asynchronous ? 2000 : 20000)
  for (const run of operations)
    for (let i = 0; i < warmup; i++) {
      if (asynchronous) await run()
      else run()
    }
  for (let round = 0; round < 41; round++) {
    if (round % 10 === 0) host()
    const pair: number[] = []
    for (let offset = 0; offset < 2; offset++) {
      const index = (offset + round) % 2
      const run = operations[index]!
      const start = Bun.nanoseconds()
      for (let i = 0; i < batch; i++) {
        if (asynchronous) await run()
        else run()
      }
      const ns = (Bun.nanoseconds() - start) / batch
      samples[index]!.push(ns)
      pair[index] = ns
    }
    ratios.push(pair[1]! / pair[0]!)
  }
  const row: Measurement = {
    name,
    unit: "ns/op",
    before: median(samples[0]!),
    after: median(samples[1]!),
    improvementPercent: (1 - median(ratios)) * 100,
    rounds: 41,
  }
  results.push(row)
  console.log(JSON.stringify(row))
}

const tmp = mkdtempSync(join(import.meta.dir, ".tmp-performance-"))
try {
  const schema = t.object({
    user: t.object({ id: t.string(), name: t.string() }),
    items: t.array(t.object({ id: t.integer(), name: t.string(), tags: t.array(t.string()) })),
  })
  const clean = {
    user: { id: "u1", name: "Ada" },
    items: Array.from({ length: 50 }, (_, i) => ({ id: i, name: `Item ${i}`, tags: ["a"] })),
  }
  const dirty = {
    ...clean,
    user: { ...clean.user, passwordHash: "must drop" },
    items: clean.items.map((item) => ({ ...item, supplier: "must drop" })),
  }
  const contract = (guard: typeof currentGuard) => ({
    label: "benchmark loader",
    guard: guard.outputGuard(schema, "benchmark", "loaderOutput"),
    missing: "",
  })
  const oldContract = contract(baselineGuard)
  const newContract = contract(currentGuard)
  assert.equal(baselineGuard.guardValue(oldContract, clean), clean)
  assert.equal(currentGuard.guardValue(newContract, clean), clean)
  assert.deepEqual(
    currentGuard.guardValue(newContract, dirty),
    baselineGuard.guardValue(oldContract, dirty),
  )
  await paired(
    "output guard, clean 50 items",
    () => baselineGuard.guardValue(oldContract, clean),
    () => currentGuard.guardValue(newContract, clean),
  )
  await paired(
    "output guard, dropping keys",
    () => baselineGuard.guardValue(oldContract, dirty),
    () => currentGuard.guardValue(newContract, dirty),
  )

  const context = {
    trace: { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" },
  }
  const oldCache = baselineCache.createCache({
    observer: baselineTracing.cacheTracing({ exporter: { onEnd() {} } }),
  })
  const newCache = currentCache.createCache({
    observer: currentTracing.cacheTracing({ exporter: { onEnd() {} } }),
  })
  const value = { id: 42 }
  await oldCache.set("user:42", value)
  await newCache.set("user:42", value)
  const loader = () => {
    throw new Error("a fresh hit must never call its loader")
  }
  assert.deepEqual(
    await oldCache.for(context).wrap("user:42", loader),
    await newCache.for(context).wrap("user:42", loader),
  )
  await paired(
    "traced cache fresh hit",
    () => oldCache.for(context).wrap("user:42", loader),
    () => newCache.for(context).wrap("user:42", loader),
    true,
  )

  const options = (): CreateWebAppOptions => {
    const modules: Record<string, RouteModule> = { "index.tsx": { default: "page" } }
    for (let i = 0; i < 4; i++) modules[`${"nested/".repeat(i)}_layout.tsx`] = { default: "layout" }
    modules["nested/nested/nested/index.tsx"] = modules["index.tsx"]!
    delete modules["index.tsx"]
    return {
      manifest: buildManifest(Object.keys(modules), (file) => async () => modules[file]!),
      clientEntry: "/client.js",
      cacheRouteModules: true,
      adapter: {
        hydrationHead: () => "",
        renderToStream: () =>
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("<p>same output</p>"))
              controller.close()
            },
          }),
      },
    }
  }
  const oldWeb = baselineWeb.createWebApp(options())
  const newWeb = currentWeb.createWebApp(options())
  const page = async (app: typeof newWeb) => {
    const response = await app.fetch(new Request("http://nifra.test/nested/nested/nested"))
    assert.equal(response.status, 200)
    return response.text()
  }
  assert.equal(await page(oldWeb), await page(newWeb))
  await paired(
    "SSR, four layouts, drained response",
    () => page(oldWeb),
    () => page(newWeb),
    true,
    200,
  )

  writeFileSync(
    join(tmp, "source.ts"),
    'import { t } from "@nifrajs/schema"; export const body = t.object({ name: t.string(), age: t.number() })',
  )
  const body = t.object({ name: t.string(), age: t.number() })
  writeFileSync(
    join(tmp, "compiled.ts"),
    compileSchema(body, { source: "./source.ts", exportName: "body" }),
  )
  const compiled: { body: typeof body } = await import(join(tmp, "compiled.ts"))
  Reflect.set(globalThis, "document", {})
  let evalFree: typeof body
  try {
    evalFree = baselineSchema.fromTypeBox(body.jsonSchema)
  } finally {
    Reflect.deleteProperty(globalThis, "document")
  }
  const input = { name: "Ada", age: 36 }
  assert.deepEqual(
    evalFree["~standard"].validate(input),
    compiled.body["~standard"].validate(input),
  )
  assert.deepEqual(
    evalFree["~standard"].validate({ ...input, secret: "refuse" }),
    compiled.body["~standard"].validate({ ...input, secret: "refuse" }),
  )
  await paired(
    "schema, eval-free runtime",
    () => evalFree["~standard"].validate(input),
    () => compiled.body["~standard"].validate(input),
  )

  const entries = [
    `import {server} from ${JSON.stringify(join(baseline, "packages/core/src/server.ts"))};import {t} from ${JSON.stringify(join(baseline, "packages/schema/src/index.ts"))};const body=t.object({name:t.string(),age:t.number()});export default server().post('/users',{body},c=>({name:c.body.name}))`,
    `import {server} from ${JSON.stringify(join(current, "packages/core/src/server.ts"))};import {body} from './compiled.ts';export default server().post('/users',{body},c=>({name:c.body.name}))`,
  ]
  const bytes: number[] = []
  for (const [index, source] of entries.entries()) {
    const file = join(tmp, `bundle-${index}.ts`)
    writeFileSync(file, source)
    const built = await Bun.build({
      entrypoints: [file],
      target: "bun",
      minify: true,
      define: { "process.env.NODE_ENV": '"production"' },
    })
    if (!built.success) throw new Error(built.logs.map(String).join("\n"))
    const code = (await Promise.all(built.outputs.map((output) => output.text()))).join("")
    bytes.push(gzipSync(Buffer.from(code)).length)
  }
  const size: Measurement = {
    name: "server with schema",
    unit: "bytes gzip",
    before: bytes[0]!,
    after: bytes[1]!,
    improvementPercent: (1 - bytes[1]! / bytes[0]!) * 100,
    rounds: 1,
  }
  results.push(size)
  console.log(JSON.stringify(size))
  host()
  const report = {
    runtime: `Bun ${Bun.version}`,
    mode: CHECK ? "proof" : "diagnostic",
    baseline,
    current,
    logicalCpus: availableParallelism(),
    hostLoadSamples: loads,
    results,
    passed:
      loads.every((load) => load <= availableParallelism() / 2) &&
      results.every((row) => row.improvementPercent >= 5),
  }
  const output = argument("--output")
  if (output !== undefined) writeFileSync(resolve(output), `${JSON.stringify(report, null, 2)}\n`)
  if (CHECK && !report.passed)
    throw new Error(
      "not every measured optimization improved by at least 5%; inspect the paired results",
    )
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
