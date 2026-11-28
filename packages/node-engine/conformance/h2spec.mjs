/**
 * Runs h2spec (`H2SPEC` names the binary, `openssl` must be on the path) against `server.mjs` over
 * TLS and fails on any case it fails.
 */
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startServer } from "./ready.mjs"

const binary = process.env.H2SPEC
if (!binary) throw new Error("set H2SPEC to the h2spec binary")

const work = mkdtempSync(join(tmpdir(), "h2spec-"))
const cert = join(work, "cert.pem")
const key = join(work, "key.pem")
execFileSync(
  "openssl",
  ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost"].concat([
    "-keyout",
    key,
    "-out",
    cert,
  ]),
  { stdio: "ignore" },
)

const { server, port } = await startServer({ TLS_CERT: cert, TLS_KEY: key })
let status = 1
try {
  const run = spawnSync(binary, ["-h", "127.0.0.1", "-p", String(port), "-t", "-k", "-o", "5"], {
    stdio: "inherit",
  })
  status = run.status ?? 1
} finally {
  server.kill()
  rmSync(work, { recursive: true, force: true })
}
process.exit(status)
