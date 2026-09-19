/**
 * Fresh-process import-time proxy for edge/Workers entrypoints.
 *
 * This is intentionally a coarse startup gate, not a claim that timing can prove the absence of every
 * top-level side effect. It catches accidental heavy imports, synchronous startup work, and runaway
 * allocation before those costs reach a cold isolate. The package-specific source/public-boundary checks
 * remain the authority for import legality.
 */

import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

const ROOT = resolve(import.meta.dir, "..")
const MAX_IMPORT_MS = 25
const SAMPLES = 5
const TARGETS = [
  {
    label: "@nifrajs/edge",
    relativePath: "packages/edge/dist/index.js",
  },
  {
    label: "@nifrajs/workers",
    relativePath: "packages/workers/src/index.ts",
  },
] as const

async function measureImport(path: string): Promise<number> {
  const specifier = pathToFileURL(path).href
  const script = [
    `const started = performance.now()`,
    `await import(${JSON.stringify(specifier)})`,
    `console.log((performance.now() - started).toFixed(3))`,
  ].join("; ")
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0)
    throw new Error(`fresh import failed for ${path}: ${stderr.trim() || stdout.trim()}`)
  const value = Number.parseFloat(stdout.trim())
  if (!Number.isFinite(value)) throw new Error(`fresh import returned no timing for ${path}`)
  return value
}

for (const target of TARGETS) {
  const path = resolve(ROOT, target.relativePath)
  if (!existsSync(path)) throw new Error(`startup target missing: ${target.relativePath}`)
  const samples: number[] = []
  for (let index = 0; index < SAMPLES; index++) samples.push(await measureImport(path))
  samples.sort((left, right) => left - right)
  const median = samples[Math.floor(samples.length / 2)] ?? Number.POSITIVE_INFINITY
  console.log(`${target.label} fresh import median ${median.toFixed(1)} ms`)
  if (median > MAX_IMPORT_MS)
    throw new Error(
      `edge startup gate failed: ${target.label} median ${median.toFixed(1)} ms > ${MAX_IMPORT_MS} ms`,
    )
}

console.log(`edge startup gate passed (median import ceiling ${MAX_IMPORT_MS} ms)`)
