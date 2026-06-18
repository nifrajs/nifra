/**
 * Cold boot — process spawn → first 200, measured on real child processes, N runs, median
 * reported. This is LOCAL process boot (what a container restart, autoscale spawn, or `bun run`
 * costs) — it is **not** a Cloudflare/Vercel edge cold start, which is dominated by the platform's
 * isolate provisioning and can only be measured against the real platform.
 *
 *   bun run bench:coldboot       (env: RUNS=10)
 */

const RUNS = Number(Bun.env.RUNS ?? 10)
const entry = new URL("./_serve.ts", import.meta.url).pathname

async function bootOnce(): Promise<number> {
  const start = Bun.nanoseconds()
  const proc = Bun.spawn(["bun", entry], {
    stdout: "pipe",
    stderr: "inherit",
    env: { ...Bun.env, PORT: "0" },
  })
  // Read the ready line for the port, then time ends at the first successful response.
  const decoder = new TextDecoder()
  let buf = ""
  let port = 0
  for await (const chunk of proc.stdout) {
    buf += decoder.decode(chunk)
    const m = buf.match(/ready (\d+)/)
    if (m) {
      port = Number(m[1])
      break
    }
  }
  const res = await fetch(`http://127.0.0.1:${port}/`)
  await res.arrayBuffer()
  const ms = (Bun.nanoseconds() - start) / 1e6
  proc.kill()
  return ms
}

const runs: number[] = []
for (let i = 0; i < RUNS; i++) runs.push(await bootOnce())
runs.sort((a, b) => a - b)
const ms = (n: number): string => `${n.toFixed(1)} ms`
console.log(
  `\nCold boot — spawn → first 200, ${RUNS} runs (local process boot, not edge cold start)`,
)
console.log(`  min     ${ms(runs[0] as number)}`)
console.log(`  median  ${ms(runs[Math.floor(runs.length / 2)] as number)}`)
console.log(`  max     ${ms(runs[runs.length - 1] as number)}`)
