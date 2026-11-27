/** The entry file the cluster tests run: primary and workers are this same file. */
import cluster from "node:cluster"
import { existsSync, readFileSync } from "node:fs"
import { server } from "@nifrajs/core"
import { serveCluster } from "../../src/cluster.ts"

const say = (event: Record<string, unknown>): void => {
  console.log(JSON.stringify(event))
}

const breakFile = process.env.BREAK_FILE
const certFile = process.env.CERT_FILE
const keyFile = process.env.KEY_FILE
// The certificate as PEM text in the entrypoint, so only `reloadTls({ cert, key })` can change it.
const inlineCert = process.env.INLINE_CERT_FILE
const inlineKey = process.env.INLINE_KEY_FILE
const reloadCert = process.env.RELOAD_CERT_FILE
const reloadKey = process.env.RELOAD_KEY_FILE
const ticketKeysHex = process.env.TICKET_KEY_HEX
const ticketKeys = ticketKeysHex === undefined ? undefined : Buffer.from(ticketKeysHex, "hex")

const tls = (() => {
  if (inlineCert !== undefined && inlineKey !== undefined) {
    const base: { cert: string; key: string; ticketKeys?: Buffer } = {
      cert: readFileSync(inlineCert, "utf8"),
      key: readFileSync(inlineKey, "utf8"),
    }
    if (ticketKeys !== undefined) base.ticketKeys = ticketKeys
    return base
  }
  if (certFile !== undefined && keyFile !== undefined) {
    const base: { cert_file_name: string; key_file_name: string; ticketKeys?: Buffer } = {
      cert_file_name: certFile,
      key_file_name: keyFile,
    }
    if (ticketKeys !== undefined) base.ticketKeys = ticketKeys
    return base
  }
  return undefined
})()

try {
  const node = await serveCluster(
    async () => {
      if (process.env.FAIL === "1") throw new Error("factory refused")
      // One worker refuses at once while the others are still starting.
      if (process.env.FAIL_FIRST === "1") {
        if (cluster.worker?.id === 1) throw new Error("first worker refused")
        await new Promise(() => {})
      }
      if (breakFile !== undefined && existsSync(breakFile)) throw new Error("broken build")
      return server().get("/pid", () => ({ pid: process.pid }))
    },
    {
      port: Number(process.env.PORT),
      hostname: "127.0.0.1",
      workers: Number(process.env.WORKERS ?? 3),
      gracefulSignals: { drainMs: 500 },
      tls,
      onWorkerEvent: (event) => say({ event: event.type, ...event }),
    },
  )
  if (node.role === "primary") {
    process.on("SIGUSR2", () => {
      node.restart({ drainMs: 500 }).then(
        () => say({ event: "restarted", workers: node.workers() }),
        (error: Error) => say({ event: "restart-failed", message: error.message }),
      )
    })
    process.on("SIGUSR1", () => {
      if (reloadCert === undefined || reloadKey === undefined) return
      node
        .reloadTls({
          cert: readFileSync(reloadCert, "utf8"),
          key: readFileSync(reloadKey, "utf8"),
        })
        .then(
          () => say({ event: "reloaded-inline" }),
          (error: Error) => say({ event: "reload-failed", message: error.message }),
        )
    })
    process.on("SIGHUP", () => {
      node.reloadTls().then(
        () => say({ event: "reloaded" }),
        (error: Error) => say({ event: "reload-failed", message: error.message }),
      )
    })
    // Last: the tests signal as soon as they read this, and an unhandled SIGUSR2 kills the process.
    say({ event: "ready", workers: node.workers() })
  }
} catch (error) {
  say({ event: "failed", message: error instanceof Error ? error.message : String(error) })
  process.exit(1)
}
