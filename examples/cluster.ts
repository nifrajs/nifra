/**
 * Multi-core nifra on Bun — one process per CPU core sharing a port via `SO_REUSEPORT`.
 *
 *   bun run examples/cluster.ts            → spawns navigator.hardwareConcurrency workers on :3000
 *   WORKERS=4 bun run examples/cluster.ts  → spawn exactly 4
 *
 * Bun is single-threaded per process, so this is the standard way to use the whole machine:
 * every worker binds the same port with `reusePort: true` and the kernel load-balances accepted
 * connections across them. Each worker is a full, independent app — anything that must be shared
 * across workers (rate-limit buckets, sessions, WebSocket pub/sub) needs a shared store (Redis,
 * a database), exactly as in any multi-instance deploy.
 *
 * Note: kernel behavior differs — Linux balances ~evenly; macOS accepts the flag but may favor
 * one socket. Benchmark multi-core throughput on Linux.
 */

const WORKER_FLAG = "--nifra-cluster-worker"

if (process.argv.includes(WORKER_FLAG)) {
  // ── Worker: the actual app. In a real project this branch is your normal server entry. ──
  const { server } = await import("@nifrajs/core")
  const app = server()
    .get("/", () => ({ hello: "world", pid: process.pid }))
    .get("/users/:id", (c) => ({ id: c.params.id, pid: process.pid }))
  app.listen(Number(Bun.env.PORT ?? 3000), { reusePort: true })
  console.log(`worker ${process.pid} listening`)
} else {
  // ── Supervisor: spawn one worker per core, restart any that dies, forward shutdown. ──
  const count = Number(Bun.env.WORKERS ?? navigator.hardwareConcurrency ?? 4)
  console.log(`spawning ${count} workers on :${Bun.env.PORT ?? 3000} (reusePort)`)
  let shuttingDown = false
  const spawn = (): ReturnType<typeof Bun.spawn> => {
    const child = Bun.spawn(["bun", import.meta.path, WORKER_FLAG], {
      stdout: "inherit",
      stderr: "inherit",
      env: Bun.env,
      onExit: () => {
        if (!shuttingDown) spawn() // a crashed worker is replaced; the port stays served
      },
    })
    return child
  }
  const children = Array.from({ length: count }, spawn)
  const shutdown = (): void => {
    shuttingDown = true
    for (const child of children) child.kill()
    process.exit(0)
  }
  process.once("SIGINT", shutdown)
  process.once("SIGTERM", shutdown)
}
