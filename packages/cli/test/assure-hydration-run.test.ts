import { afterAll, expect, test } from "bun:test"
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
