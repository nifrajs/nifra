// Bundled for Node by ../profile-preact.ts. Reuses the published catalog route and its guard.
import { buildManifest, createWebApp, type RouteModule } from "@nifrajs/web"
import { adapter } from "./backend/framework.ts"
import * as backend from "./routes/index.backend.ts"
import * as frontend from "./routes/index.tsx"

const modules = { "index.tsx": frontend, "index.backend.ts": backend }
const manifest = buildManifest(Object.keys(modules), (file) => async () => {
  const half = file === "index.tsx" ? frontend : backend
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The manifest merges the backend half with the frontend default.
  return half as RouteModule
})
const measurements = new Map<string, number[]>()
let phases: Map<string, number> | undefined
const app = createWebApp({
  adapter,
  manifest,
  clientEntry: "/assets/entry.js",
  routeTiming: () => {
    const sample = phases
    if (sample === undefined) return undefined
    return (phase, ms) => sample.set(phase, (sample.get(phase) ?? 0) + ms)
  },
})

for (let i = 0; i < 2000; i++) {
  const record = i >= 1000 ? new Map<string, number>() : undefined
  phases = record
  const started = performance.now()
  const response = await app.fetch(new Request("http://127.0.0.1/"))
  const elapsed = performance.now() - started
  if (!response.ok || !(await response.text()).includes("Item 50")) {
    throw new Error("Unexpected catalog response")
  }
  if (record === undefined) continue
  record.set("fetch", elapsed)
  for (const [phase, ms] of record) {
    const samples = measurements.get(phase)
    if (samples === undefined) measurements.set(phase, [ms])
    else samples.push(ms)
  }
}

const percentiles = (values: number[]) => {
  values.sort((a, b) => a - b)
  return {
    p50: values[Math.ceil(values.length * 0.5) - 1],
    p99: values[Math.ceil(values.length * 0.99) - 1],
  }
}
for (const phase of ["pageLoader", "validation", "serialization", "render", "fetch"]) {
  if (measurements.get(phase)?.length !== 1000) throw new Error(`Missing samples for ${phase}`)
}
console.log(
  JSON.stringify(
    {
      node: process.version,
      scope: "Warmed app.fetch, one request at a time through response creation",
      samples: 1000,
      milliseconds: Object.fromEntries(
        [...measurements].map(([phase, values]) => [phase, percentiles(values)]),
      ),
    },
    null,
    2,
  ),
)
