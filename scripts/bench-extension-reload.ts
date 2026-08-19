import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import { ExtensionHost, validateExtensionModule } from "@nifrajs/coding-agent"

const runs = Number(Bun.argv.find((arg) => arg.startsWith("--runs="))?.slice(7) ?? "20")
if (!Number.isSafeInteger(runs) || runs < 1 || runs > 500)
  throw new Error("--runs must be between 1 and 500")

const cwd = await mkdtemp(join(tmpdir(), "nifra-agent-reload-bench-"))
try {
  const path = join(cwd, "extension.ts")
  await writeFile(
    path,
    `export default ({ registerCommand }) => registerCommand("ping", async () => "pong")`,
  )
  const host = new ExtensionHost({
    cwd,
    roots: ["extension.ts"],
    validate: validateExtensionModule,
  })
  const started = performance.now()
  for (let index = 0; index < runs; index++) {
    const result = await host.reload()
    if (result.rolledBack) throw new Error(result.error ?? "extension reload failed")
  }
  const elapsedMs = performance.now() - started
  const result = {
    runs,
    totalMs: round(elapsedMs),
    averageMs: round(elapsedMs / runs),
    currentRevision: host.currentRevision,
  }
  if (Bun.argv.includes("--json")) console.log(JSON.stringify(result))
  else console.log(`extension reload: ${result.averageMs}ms average (${result.runs} runs)`)
  await host.close()
} finally {
  await rm(cwd, { recursive: true, force: true })
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
