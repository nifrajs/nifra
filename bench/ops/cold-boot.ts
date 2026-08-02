/**
 * Cold boot - process spawn → first 200, measured on real child processes, N runs, median
 * reported. This is LOCAL process boot (what a container restart, autoscale spawn, or `bun run`
 * costs) - it is **not** a Cloudflare/Vercel edge cold start, which is dominated by the platform's
 * isolate provisioning and can only be measured against the real platform.
 *
 *   bun run bench:coldboot       (env: RUNS=10 BENCH_PORT=45678)
 */

const RUNS = Number(Bun.env.RUNS ?? 10)
if (!Number.isInteger(RUNS) || RUNS < 1) {
  throw new Error(`RUNS must be a positive integer (received ${RUNS})`)
}
// Bun's native route table has a flaky port-0 bind/cleanup path on some versions. A fixed port
// keeps the boot measurement about process startup, not ephemeral-port allocation; override it for
// parallel local runs or CI jobs that reserve a different port.
const BENCH_PORT = Number(Bun.env.BENCH_PORT ?? 45678)
if (!Number.isInteger(BENCH_PORT) || BENCH_PORT < 1 || BENCH_PORT > 65_535) {
  throw new Error(`BENCH_PORT must be an integer between 1 and 65535 (received ${BENCH_PORT})`)
}
const entry = new URL("./_serve.ts", import.meta.url).pathname

async function bootOnce(): Promise<number> {
  const start = Bun.nanoseconds()
  const proc = Bun.spawn(["bun", entry], {
    stdout: "pipe",
    stderr: "inherit",
    env: { ...Bun.env, PORT: String(BENCH_PORT) },
  })
  try {
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
    if (port === 0) {
      throw new Error("cold-boot child exited before reporting a listening port")
    }
    const res = await fetch(`http://127.0.0.1:${port}/`)
    await res.arrayBuffer()
    return (Bun.nanoseconds() - start) / 1e6
  } finally {
    proc.kill()
    // Await process teardown before the next fixed-port spawn. Bun's native route table can otherwise
    // race socket cleanup and report a misleading EADDRINUSE startup error.
    await proc.exited
  }
}

const runs: number[] = []
for (let i = 0; i < RUNS; i++) runs.push(await bootOnce())
runs.sort((a, b) => a - b)
const ms = (n: number): string => `${n.toFixed(1)} ms`
console.log(
  `\nCold boot - spawn → first 200, ${RUNS} runs (local process boot, not edge cold start)`,
)
console.log(`  min     ${ms(runs[0] as number)}`)
console.log(`  median  ${ms(runs[Math.floor(runs.length / 2)] as number)}`)
console.log(`  max     ${ms(runs[runs.length - 1] as number)}`)
