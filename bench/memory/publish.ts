import { activeBenchRuntimeVersions, assertBenchmarkPublishable } from "../publish-guard.ts"
import { writeSiteBench } from "../site-bench.ts"
import { memoryCapture } from "./results.ts"

export async function publishMemory(path: string): Promise<void> {
  const capture = memoryCapture(await Bun.file(path).json())
  await assertBenchmarkPublishable({ ...activeBenchRuntimeVersions(), node: capture.node })
  await writeSiteBench({ httpMemory: capture })
}

if (import.meta.main) {
  const path = process.argv[2]
  if (path === undefined)
    throw new Error("usage: bun bench/memory/publish.ts <realworld-memory.json>")
  await publishMemory(path)
}
