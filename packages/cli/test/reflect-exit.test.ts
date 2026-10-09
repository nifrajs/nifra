import { afterEach, beforeEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { createFixtureRoot, removeFixtureRoot, writeAppFile } from "./fixture-root.ts"

const CLI = resolve(import.meta.dir, "../src/cli.ts")
let root: string

beforeEach(() => {
  root = createFixtureRoot("tmp-reflect-exit-")
  // An app that records what it was told and, like a Redis client retrying, can hold the process open.
  writeAppFile(
    root,
    "backend/app.ts",
    [
      'import { writeFileSync } from "node:fs"',
      'import { server } from "@nifrajs/core"',
      'writeFileSync(new URL("../reflect.txt", import.meta.url), process.env.NIFRA_REFLECT ?? "")',
      'if (process.env.HOLD_OPEN === "1") setInterval(() => {}, 60_000)',
      'export const backend = server().get("/x", () => "x")',
      "",
    ].join("\n"),
  )
})
afterEach(() => removeFixtureRoot(root))

async function routes(
  holdOpen: boolean,
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, CLI, "routes"], {
    cwd: root,
    env: { ...process.env, HOLD_OPEN: holdOpen ? "1" : "0" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exit, stdout, stderr }
}

test("a reflecting command tells the app it is being read", async () => {
  const run = await routes(false)
  expect(run.exit).toBe(0)
  expect(run.stdout).toContain("/x")
  expect(run.stderr).not.toContain("keeping the process alive")
  expect(readFileSync(join(root, "reflect.txt"), "utf8")).toBe("routes")
})

test("a reflecting command exits after answering when the app holds the process open", async () => {
  const run = await routes(true)
  expect(run.exit).toBe(0)
  expect(run.stdout).toContain("/x")
  expect(run.stderr).toContain(
    "`nifra routes` has finished, but something the app started when it was imported",
  )
  expect(run.stderr).toContain("process.env.NIFRA_REFLECT")
}, 30_000)
