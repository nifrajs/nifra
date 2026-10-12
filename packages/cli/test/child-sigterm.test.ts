import { afterAll, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { watch } from "node:fs/promises"
import { join } from "node:path"
import { runHydrationAssurance } from "../src/assure-hydration.ts"
import { spawnChild, WarmWorker } from "../src/mcp-exec.ts"
import { escalatingStop } from "../src/mcp-io.ts"
import {
  createFixtureProject,
  createFixtureRoot,
  removeFixtureRoot,
  writeAppFile,
} from "./fixture-root.ts"

const root = createFixtureRoot("child-sigterm-")
afterAll(() => removeFixtureRoot(root))

/** Resolves once `file` exists in `dir`: the project has installed its SIGTERM handler. */
async function fileAppears(dir: string, file: string): Promise<void> {
  const watcher = new AbortController()
  try {
    const events = watch(dir, { signal: watcher.signal })
    if (existsSync(join(dir, file))) return
    for await (const _event of events) if (existsSync(join(dir, file))) return
  } finally {
    watcher.abort()
  }
}

// A graceful-shutdown hook that never finishes, in front of a request that never answers.
function ignoringApp(): string {
  const dir = createFixtureProject(root, "app-")
  writeAppFile(dir, "package.json", JSON.stringify({ name: "ignores-sigterm", type: "module" }))
  writeAppFile(
    dir,
    "backend/app.ts",
    [
      'import { writeFileSync } from "node:fs"',
      "process.on('SIGTERM', () => {})",
      `writeFileSync(${JSON.stringify(join(dir, "ready"))}, "")`,
      "export const backend = { fetch: () => new Promise(() => {}) }",
      "",
    ].join("\n"),
  )
  return dir
}

test("escalatingStop sends SIGKILL after the grace period", async () => {
  const sent: string[] = []
  const killed = Promise.withResolvers<void>()
  const stopper = escalatingStop((name) => {
    sent.push(name)
    if (name === "SIGKILL") killed.resolve()
  }, 0)
  stopper.stop()
  await killed.promise
  expect(sent).toEqual(["SIGTERM", "SIGKILL"])
  stopper.dispose()
  stopper.stop()
  expect(sent).toEqual(["SIGTERM", "SIGKILL"])
})

test("a cancelled nifra_run ends even when the app ignores SIGTERM", async () => {
  const dir = ignoringApp()
  const controller = new AbortController()
  const ready = fileAppears(dir, "ready")
  const run = spawnChild("mcp-run", dir, { requests: [{ path: "/" }] }, "run", controller.signal)
  await ready
  controller.abort("client cancelled")
  expect(await run).toBe("run cancelled: client cancelled.")
}, 60_000)

test("stopping a warm worker ends it even when the app ignores SIGTERM", async () => {
  const dir = ignoringApp()
  const ready = fileAppears(dir, "ready")
  const worker = new WarmWorker("mcp-run", dir, "fingerprint", "run")
  const pending = worker.request({ requests: [{ path: "/" }] })
  await ready
  worker.stop()
  await expect(pending).rejects.toThrow(/warm run worker exited/)
}, 60_000)

test("a cancelled hydration run ends even when the project ignores SIGTERM", async () => {
  const dir = createFixtureProject(root, "hydration-")
  writeAppFile(dir, "package.json", JSON.stringify({ name: "hydration-sigterm", type: "module" }))
  writeAppFile(
    dir,
    "nifra.config.ts",
    [
      'import { writeFileSync } from "node:fs"',
      "process.on('SIGTERM', () => {})",
      `writeFileSync(${JSON.stringify(join(dir, "ready"))}, "")`,
      "await new Promise(() => {})",
      "",
    ].join("\n"),
  )
  writeAppFile(
    dir,
    "backend/app.ts",
    'import { server } from "@nifrajs/core"\nexport const backend = server()\n',
  )
  writeAppFile(dir, "routes/index.tsx", "export default () => null\n")
  const controller = new AbortController()
  const ready = fileAppears(dir, "ready")
  const run = runHydrationAssurance(dir, {}, { signal: controller.signal })
  await ready
  controller.abort()
  const result = await run
  expect(result.diagnostics[0]?.message).toBe("hydration runner failed: cancelled")
}, 60_000)
