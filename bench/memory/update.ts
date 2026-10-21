import { assertBenchmarkPublishable } from "../publish-guard.ts"
import { publishMemory } from "./publish.ts"

await assertBenchmarkPublishable()
const capture = Bun.spawn(["bun", "run", "bench:memory"], { stdout: "inherit", stderr: "inherit" })
if ((await capture.exited) !== 0) throw new Error("memory capture failed")
await publishMemory("bench/profiling/results/realworld-memory.json")
