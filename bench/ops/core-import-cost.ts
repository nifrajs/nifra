/**
 * Fresh-process import parity for the lean package root and explicit server seam.
 * This measures module parsing/evaluation only; it is not an HTTP throughput benchmark.
 *
 *   bun run bench:core-import       (env: RUNS=30)
 */

import { resolve } from "node:path"

const RUNS = Number(Bun.env.RUNS ?? 30)
const ROOT = resolve(import.meta.dir, "../..")

function measure(specifier: string): number[] {
  const source = `const start = performance.now(); await import(${JSON.stringify(specifier)}); console.log(performance.now() - start)`
  const samples: number[] = []

  for (let index = 0; index < RUNS; index += 1) {
    const child = Bun.spawnSync(["bun", "-e", source], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    })
    if (child.exitCode !== 0) {
      throw new Error(new TextDecoder().decode(child.stderr))
    }
    samples.push(Number(new TextDecoder().decode(child.stdout).trim()))
  }

  return samples.sort((a, b) => a - b)
}

function median(samples: readonly number[]): number {
  return samples[Math.floor(samples.length / 2)] as number
}

const root = measure("@nifrajs/core")
const serverEntry = measure("@nifrajs/core/server")
const rootMedian = median(root)
const serverMedian = median(serverEntry)
const delta = rootMedian - serverMedian

console.log(`Fresh Bun import, ${RUNS} processes`)
console.log(`  @nifrajs/core         ${rootMedian.toFixed(3)} ms median`)
console.log(`  @nifrajs/core/server  ${serverMedian.toFixed(3)} ms median`)
console.log(`  root delta            ${delta.toFixed(3)} ms`)
