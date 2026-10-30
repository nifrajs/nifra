import { assertBenchmarkPublishable } from "../publish-guard.ts"
import { publishMemory } from "./publish.ts"

await assertBenchmarkPublishable()
for (const runtime of ["node", "bun", "deno"] as const) {
  console.log(`Capturing HTTP memory on ${runtime}`)
  const capture = Bun.spawn(
    [
      "node",
      "bench/profiling/run.mjs",
      "--mode=memory",
      "--packaging=native",
      "--rounds=5",
      "--requests=50000",
      `--runtime=${runtime}`,
      `--out=bench/profiling/results/${runtime}`,
    ],
    { stdout: "inherit", stderr: "inherit" },
  )
  if ((await capture.exited) !== 0) throw new Error(`${runtime} memory capture failed`)
  await publishMemory(`bench/profiling/results/${runtime}/realworld-memory.json`)
}
