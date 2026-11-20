/** Compare the existing Node Preact rows, then measure Nifra's isolated application stages. */
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { buildTarget as buildNifra } from "@nifrajs/web/build"
import {
  buildTarget,
  measureOnce,
  SSR_BENCH_CONNECTIONS,
  SSR_BENCH_DURATION_S,
  SSR_BENCH_WARMUP_S,
} from "./harness.ts"
import { PREACT_TABLE_A } from "./targets.ts"

const nifra = PREACT_TABLE_A.find(
  (target) => target.runtime === "node" && target.kind !== "renderer",
)
const raw = PREACT_TABLE_A.find((target) => target.kind === "renderer")
if (nifra?.cwd === undefined || raw === undefined) throw new Error("Missing Node Preact fixtures")
const temp = mkdtempSync(join(import.meta.dir, ".preact-profile-"))
try {
  const dist = join(temp, "dist")
  await buildNifra("node", {
    routesDir: join(nifra.cwd, "routes"),
    adapterImport: join(nifra.cwd, "backend/framework.ts"),
    clientModule: "@nifrajs/web-preact/client",
    outDir: dist,
    workDir: join(temp, "work"),
  })
  await buildTarget(raw)
  const targets = [{ ...nifra, serve: ["node", join(dist, "server.js")] }, raw]
  const rounds: Record<string, Awaited<ReturnType<typeof measureOnce>>[]> = {}
  for (const order of [targets, [...targets].reverse()]) {
    for (const target of order) {
      const sample = await measureOnce(target, false)
      const samples = rounds[target.name] ?? []
      samples.push(sample)
      rounds[target.name] = samples
    }
  }
  console.log(
    JSON.stringify(
      {
        connections: SSR_BENCH_CONNECTIONS,
        durationSeconds: SSR_BENCH_DURATION_S,
        warmupSeconds: SSR_BENCH_WARMUP_S,
        rounds,
      },
      null,
      2,
    ),
  )
  const profile = join(temp, "profile.mjs")
  const build = await Bun.build({
    entrypoints: [join(nifra.cwd, "profile.ts")],
    outdir: temp,
    naming: "profile.mjs",
    target: "node",
    define: { "process.env.NODE_ENV": '"production"' },
  })
  if (!build.success)
    throw new AggregateError(build.logs, "Node Preact phase profiler did not build")
  const proc = Bun.spawn(["node", profile], { stdout: "inherit", stderr: "inherit" })
  if ((await proc.exited) !== 0) throw new Error("Node Preact phase profiler failed")
} finally {
  rmSync(temp, { recursive: true, force: true })
}
