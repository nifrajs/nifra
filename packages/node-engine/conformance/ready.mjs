/** Starts `server.mjs` and resolves once it has printed its whole `ready <port>` line. */
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"

export async function startServer(env = {}) {
  const server = spawn(
    process.execPath,
    [fileURLToPath(new URL("./server.mjs", import.meta.url))],
    {
      env: { ...process.env, PORT: "0", ...env },
      stdio: ["ignore", "pipe", "inherit"],
    },
  )
  for await (const line of createInterface({ input: server.stdout })) {
    const port = /^ready (\d+)$/.exec(line)?.[1]
    if (port === undefined) continue
    server.stdout.resume()
    return { server, port: Number(port) }
  }
  throw new Error("the conformance server exited before it was ready")
}
