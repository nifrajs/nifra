import { afterAll, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { watch } from "node:fs/promises"
import { join } from "node:path"
import { runHydrationAssurance } from "../src/assure-hydration.ts"
import { createFixtureRoot, removeFixtureRoot, writeAppFile } from "./fixture-root.ts"

const root = createFixtureRoot("hydration-run-")
afterAll(() => removeFixtureRoot(root))

writeAppFile(
  root,
  "package.json",
  JSON.stringify({ name: "hydration-run", private: true, type: "module" }),
)
writeAppFile(
  root,
  "nifra.config.ts",
  [
    'console.log("[config] loaded")',
    'process.stdout.write("{not the answer\\n")',
    "export const adapter = {}",
    'export const clientModule = "@nifrajs/web-react/client"',
    "",
  ].join("\n"),
)
writeAppFile(
  root,
  "backend/app.ts",
  'import { server } from "@nifrajs/core"\nexport const backend = server().get("/health", () => ({ ok: true }))\n',
)
writeAppFile(root, "routes/index.tsx", "export default () => null\n")

test("what project code prints is never read as the hydration result", async () => {
  const result = await runHydrationAssurance(root)
  expect(result.diagnostics).toEqual([])
  expect(result.skipReason).toBe("no happy-dom dependency configured for DOM hydration execution")
}, 60_000)

test("a hydration run stops at its timeout or a cancel", async () => {
  const timedOut = await runHydrationAssurance(root, {}, { timeoutMs: 1 })
  expect(timedOut.diagnostics[0]?.message).toBe("hydration runner failed: timed out after 1 ms")
  const controller = new AbortController()
  controller.abort()
  const cancelled = await runHydrationAssurance(root, {}, { signal: controller.signal })
  expect(cancelled.diagnostics[0]?.message).toBe("hydration runner failed: cancelled")
}, 60_000)

const spawner = createFixtureRoot("hydration-group-")
afterAll(() => removeFixtureRoot(spawner))
const marker = join(spawner, "grandchild.pid")
writeAppFile(spawner, "package.json", JSON.stringify({ name: "hydration-group", type: "module" }))
writeAppFile(
  spawner,
  "nifra.config.ts",
  [
    'import { spawn } from "node:child_process"',
    'import { writeFileSync } from "node:fs"',
    "// A process the project started, holding the run's output pipes open.",
    'const held = spawn("sleep", ["600"], { stdio: ["ignore", "inherit", "inherit"] })',
    `writeFileSync(${JSON.stringify(marker)}, String(held.pid))`,
    "await new Promise(() => {})",
    "",
  ].join("\n"),
)
writeAppFile(
  spawner,
  "backend/app.ts",
  'import { server } from "@nifrajs/core"\nexport const backend = server()\n',
)
writeAppFile(spawner, "routes/index.tsx", "export default () => null\n")

test.skipIf(process.platform === "win32")(
  "a cancel stops every process the run started, so the run ends",
  async () => {
    const controller = new AbortController()
    const watcher = new AbortController()
    const started = (async () => {
      const events = watch(spawner, { signal: watcher.signal })
      if (existsSync(marker)) return
      for await (const _event of events) if (existsSync(marker)) return
    })()
    const run = runHydrationAssurance(spawner, {}, { signal: controller.signal })
    try {
      await started
      controller.abort()
      const result = await run
      expect(result.diagnostics[0]?.message).toBe("hydration runner failed: cancelled")
    } finally {
      watcher.abort()
      const pid = Number(readFileSync(marker, "utf8"))
      try {
        process.kill(pid, "SIGKILL")
      } catch {}
    }
  },
  60_000,
)
