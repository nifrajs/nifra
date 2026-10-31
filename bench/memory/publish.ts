import type { HttpMemoryRuntime } from "../../site/shared/data/memory-types.ts"
import { activeBenchRuntimeVersions, assertBenchmarkPublishable } from "../publish-guard.ts"
import { writeSiteBench } from "../site-bench.ts"
import { memoryCapture } from "./results.ts"

export type MemoryCapture = ReturnType<typeof memoryCapture>

const MEMORY_RUNTIMES: readonly HttpMemoryRuntime[] = ["node", "bun", "deno"]

interface MemoryHost {
  readonly cpu: string
  readonly platform: string
  readonly runtime?: string
}

function isMemoryHost(value: unknown): value is MemoryHost {
  return (
    typeof value === "object" &&
    value !== null &&
    "cpu" in value &&
    typeof value.cpu === "string" &&
    "platform" in value &&
    typeof value.platform === "string" &&
    (!("runtime" in value) || typeof value.runtime === "string")
  )
}

export function assertPartialMemoryHost(capture: MemoryCapture, stored: unknown): void {
  const retained = isMemoryHost(stored)
    ? [stored]
    : typeof stored === "object" && stored !== null
      ? Object.values(stored).filter(isMemoryHost)
      : []
  const mismatch = retained.find(
    (existing) => existing.cpu !== capture.cpu || existing.platform !== capture.platform,
  )
  if (mismatch !== undefined) {
    throw new Error(
      `refusing to merge ${capture.runtime} memory capture from ${capture.cpu} (${capture.platform}); retained ${mismatch.runtime ?? "legacy"} capture is from ${mismatch.cpu} (${mismatch.platform})`,
    )
  }
}

async function storedMemory(): Promise<unknown> {
  const data = await Bun.file(
    new URL("../../site/shared/data/benchmarks.json", import.meta.url),
  ).json()
  return typeof data === "object" && data !== null && "httpMemory" in data
    ? data.httpMemory
    : undefined
}

export function fullMemoryBatch(
  captures: readonly MemoryCapture[],
): Partial<Record<HttpMemoryRuntime, MemoryCapture>> {
  if (captures.length !== MEMORY_RUNTIMES.length) {
    throw new Error(`full memory batch requires ${MEMORY_RUNTIMES.length} runtime captures`)
  }

  const byRuntime: Partial<Record<HttpMemoryRuntime, MemoryCapture>> = {}
  for (const capture of captures) {
    if (byRuntime[capture.runtime] !== undefined) {
      throw new Error(`duplicate ${capture.runtime} capture in full memory batch`)
    }
    byRuntime[capture.runtime] = capture
  }

  const missing = MEMORY_RUNTIMES.filter((runtime) => byRuntime[runtime] === undefined)
  if (missing.length > 0) {
    throw new Error(`full memory batch is missing ${missing.join(", ")}`)
  }

  const first = captures[0]
  if (first === undefined) throw new Error("full memory batch is empty")
  const mismatch = captures.find(
    (capture) => capture.cpu !== first.cpu || capture.platform !== first.platform,
  )
  if (mismatch !== undefined) {
    throw new Error(
      `full memory batch must use one CPU and platform; ${mismatch.runtime} is from ${mismatch.cpu} (${mismatch.platform}) while ${first.runtime} is from ${first.cpu} (${first.platform})`,
    )
  }
  return byRuntime
}

export async function publishMemory(path: string): Promise<void> {
  const capture = memoryCapture(await Bun.file(path).json())
  assertPartialMemoryHost(capture, await storedMemory())
  await assertBenchmarkPublishable({
    ...activeBenchRuntimeVersions(),
    [capture.runtime]: capture.runtimeVersion,
  })
  await writeSiteBench({ httpMemory: { [capture.runtime]: capture } })
}

export async function publishMemoryBatch(paths: readonly string[]): Promise<void> {
  const captures = await Promise.all(
    paths.map(async (path) => memoryCapture(await Bun.file(path).json())),
  )
  const httpMemory = fullMemoryBatch(captures)
  const runtimeVersions: Partial<Record<HttpMemoryRuntime, string>> = {}
  for (const capture of captures) runtimeVersions[capture.runtime] = capture.runtimeVersion

  await assertBenchmarkPublishable({ ...activeBenchRuntimeVersions(), ...runtimeVersions })
  await writeSiteBench({ httpMemory })
}

if (import.meta.main) {
  const path = process.argv[2]
  if (path === undefined)
    throw new Error("usage: bun bench/memory/publish.ts <realworld-memory.json>")
  await publishMemory(path)
}
