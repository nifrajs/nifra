/** The entry file the cluster tests run: primary and workers are this same file. */
import { existsSync } from "node:fs"
import { server } from "@nifrajs/core"
import { serveCluster } from "../../src/cluster.ts"

const say = (event: Record<string, unknown>): void => {
  console.log(JSON.stringify(event))
}

const breakFile = process.env.BREAK_FILE
const certFile = process.env.CERT_FILE
const keyFile = process.env.KEY_FILE

try {
  const node = await serveCluster(
    () => {
      if (process.env.FAIL === "1") throw new Error("factory refused")
      if (breakFile !== undefined && existsSync(breakFile)) throw new Error("broken build")
      return server().get("/pid", () => ({ pid: process.pid }))
    },
    {
      port: Number(process.env.PORT),
      hostname: "127.0.0.1",
      workers: Number(process.env.WORKERS ?? 3),
      gracefulSignals: { drainMs: 500 },
      tls:
        certFile === undefined || keyFile === undefined
          ? undefined
          : { cert_file_name: certFile, key_file_name: keyFile },
      onWorkerEvent: (event) => say({ event: event.type, ...event }),
    },
  )
  if (node.role === "primary") {
    say({ event: "ready", workers: node.workers() })
    process.on("SIGUSR2", () => {
      node.restart({ drainMs: 500 }).then(
        () => say({ event: "restarted", workers: node.workers() }),
        (error: Error) => say({ event: "restart-failed", message: error.message }),
      )
    })
    process.on("SIGHUP", () => {
      node.reloadTls().then(
        () => say({ event: "reloaded" }),
        (error: Error) => say({ event: "reload-failed", message: error.message }),
      )
    })
  }
} catch (error) {
  say({ event: "failed", message: error instanceof Error ? error.message : String(error) })
  process.exit(1)
}
