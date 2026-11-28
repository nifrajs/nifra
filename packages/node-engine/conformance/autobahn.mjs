/**
 * Runs the Autobahn fuzzing client (pinned image, needs Docker) against `server.mjs` and fails on
 * any case it marks failed. `AUTOBAHN_CASES` narrows the run, comma separated. Case 9.* measures
 * throughput rather than conformance and is left out.
 */
import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startServer } from "./ready.mjs"

const IMAGE =
  "crossbario/autobahn-testsuite@sha256:519915fb568b04c9383f70a1c405ae3ff44ab9e35835b085239c258b6fac3074"
const linux = process.platform === "linux"
const work = mkdtempSync(join(tmpdir(), "autobahn-"))
mkdirSync(join(work, "config"))
mkdirSync(join(work, "reports"))
// The container's user writes the report.
chmodSync(join(work, "reports"), 0o777)

const { server, port } = await startServer({ WS_DEFLATE: "1" })
let failed = []
try {
  const host = linux ? "127.0.0.1" : "host.docker.internal"
  writeFileSync(
    join(work, "config", "fuzzingclient.json"),
    JSON.stringify({
      outdir: "/reports",
      servers: [{ agent: "nifra-engine", url: `ws://${host}:${port}/ws` }],
      cases: (process.env.AUTOBAHN_CASES ?? "*").split(","),
      "exclude-cases": ["9.*"],
      "exclude-agent-cases": {},
    }),
  )
  execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "--platform",
      "linux/amd64",
      ...(linux ? ["--network", "host"] : []),
      "-v",
      `${join(work, "config")}:/config:ro`,
      "-v",
      `${join(work, "reports")}:/reports`,
      IMAGE,
      "wstest",
      "-m",
      "fuzzingclient",
      "-s",
      "/config/fuzzingclient.json",
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  )
  const report = JSON.parse(readFileSync(join(work, "reports", "index.json"), "utf8"))
  const cases = Object.entries(report["nifra-engine"] ?? {})
  const accepted = new Set(["OK", "NON-STRICT", "INFORMATIONAL"])
  failed = cases
    .filter(([, r]) => !accepted.has(r.behavior) || !accepted.has(r.behaviorClose))
    .map(([name, r]) => `${name} ${r.behavior}/${r.behaviorClose}`)
  console.log(`${cases.length} cases, ${failed.length} failed`)
  for (const entry of failed.slice(0, 40)) console.log(entry)
  if (cases.length === 0) failed = ["no case ran"]
} finally {
  server.kill()
}
if (failed.length > 0) process.exit(1)
