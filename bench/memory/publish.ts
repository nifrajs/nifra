import { activeBenchRuntimeVersions, assertBenchmarkPublishable } from "../publish-guard.ts"
import { writeSiteBench } from "../site-bench.ts"
import { memoryCapture } from "./results.ts"

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

async function assertSameMemoryHost(capture: ReturnType<typeof memoryCapture>): Promise<void> {
  const data = await Bun.file(
    new URL("../../site/shared/data/benchmarks.json", import.meta.url),
  ).json()
  const stored =
    typeof data === "object" && data !== null && "httpMemory" in data ? data.httpMemory : undefined
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

export async function publishMemory(path: string): Promise<void> {
  const capture = memoryCapture(await Bun.file(path).json())
  await assertSameMemoryHost(capture)
  await assertBenchmarkPublishable({
    ...activeBenchRuntimeVersions(),
    [capture.runtime]: capture.runtimeVersion,
  })
  await writeSiteBench({ httpMemory: { [capture.runtime]: capture } })
}

if (import.meta.main) {
  const path = process.argv[2]
  if (path === undefined)
    throw new Error("usage: bun bench/memory/publish.ts <realworld-memory.json>")
  await publishMemory(path)
}
