import assert from "node:assert/strict"
import { readdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { performance } from "node:perf_hooks"
import { pathToFileURL } from "node:url"
import { brotliCompressSync, gzipSync } from "node:zlib"

const adapter = process.env.NIFRA_COMPONENT_ADAPTER
const out = resolve(process.env.NIFRA_COMPONENT_OUT)
const entry = await import(
  pathToFileURL(resolve(out, adapter === "react" ? "ssr/index.js" : "server/index.js")).href
)
const assets = (await readdir(resolve(out, "assets"))).map((name) => `/assets/${name}`)
const benchmark = await entry.createBenchmark(assets)
const percentile = (values, ratio) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * ratio) - 1]
const durations = async (call) => {
  for (let index = 0; index < 30; index++) await call()
  const values = []
  for (let index = 0; index < 200; index++) {
    const start = performance.now()
    await call()
    values.push(performance.now() - start)
  }
  return values
}
const results = []
for (const refresh of [false, true]) {
  const baseline = await benchmark.baseline(refresh)
  const enabled = await benchmark.enabled(refresh)
  // React's compiler-owned preload hints are removed by the feature's transport boundary.
  const markup = (state) =>
    state.records
      .map((record) =>
        record.html.replace(/<link\b[^>]*rel="(?:preload|modulepreload)"[^>]*>/g, ""),
      )
      .join("")
  assert.equal(
    markup(enabled),
    markup(baseline),
    "Equal-work baseline must render identical native markup",
  )
  const runs = []
  for (let run = 0; run < 5; run++) {
    const base = await durations(() => benchmark.baseline(refresh))
    const feature = await durations(() => benchmark.enabled(refresh))
    runs.push({
      baselineP95: percentile(base, 0.95),
      enabledP95: percentile(feature, 0.95),
      baselineP50: percentile(base, 0.5),
      enabledP50: percentile(feature, 0.5),
    })
  }
  const baselineP95 = percentile(
    runs.map((run) => run.baselineP95),
    0.5,
  )
  const enabledP95 = percentile(
    runs.map((run) => run.enabledP95),
    0.5,
  )
  const addedMs = enabledP95 - baselineP95
  assert.ok(
    addedMs <= 20,
    `${adapter} ${refresh ? "refresh" : "SSR"} added processing ${addedMs} exceeds 20ms`,
  )
  if (!refresh)
    assert.ok(
      enabledP95 <= baselineP95 * 1.25,
      `${adapter} SSR exceeds the 1.25x equal-work baseline`,
    )
  results.push({
    operation: refresh ? "refresh" : "initial-SSR",
    baselineP95,
    enabledP95,
    addedMs,
    runs,
  })
}
const bundles = []
for (const name of await readdir(resolve(out, "assets"))) {
  const bytes = await readFile(resolve(out, "assets", name))
  if (/\.(?:js|css)$/.test(name))
    bundles.push({
      file: name,
      bytes: bytes.length,
      gzip: gzipSync(bytes).length,
      brotli: brotliCompressSync(bytes).length,
    })
}
const evidence = {
  adapter,
  status: "passed",
  samples: 200,
  warmups: 30,
  runs: 5,
  ioMs: 20,
  node: process.version,
  results,
  bundles,
}
await writeFile(
  resolve(out, "../../", `performance-${adapter}.json`),
  `${JSON.stringify(evidence, null, 2)}\n`,
)
console.log(JSON.stringify(evidence))
