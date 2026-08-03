import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assertBunDevSupportsApp } from "../src/cli.ts"

/**
 * `nifra dev --bun` gates. Server functions and `*.server` modules are NO LONGER refused: the
 * generated bunfig channel (see dev-bun-config.test.ts) delivers the production boundary plugins to
 * Bun's dev-server bundler, so those modules are stubbed/emptied exactly as in `nifra build`. The
 * one remaining refusal is CSS Modules, whose plugin is not yet verified under `[serve.static]` -
 * its failure mode is a broken client, so the gate stays loud until it is.
 */

type App = Parameters<typeof assertBunDevSupportsApp>[0]
const appAt = (cwd: string): App => ({ cwd }) as App

async function inTemp(
  files: Record<string, string>,
  run: (cwd: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "nifra-bundev-"))
  try {
    for (const [rel, body] of Object.entries(files)) {
      const full = join(root, rel)
      mkdirSync(join(full, ".."), { recursive: true })
      writeFileSync(full, body)
    }
    await run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test("a clean app is allowed", async () => {
  await inTemp({ "src/app.ts": "export const app = 1" }, async (cwd) => {
    expect(await assertBunDevSupportsApp(appAt(cwd))).toBeUndefined()
  })
})

test("*.server and *.fn modules are allowed - the bunfig channel strips them", async () => {
  await inTemp(
    {
      "src/db.server.ts": 'export const KEY = "sk-live"',
      "src/todos.fn.ts": "export const addTodo = 1",
      "src/db.server": 'export const SECRET = "sk-live"',
      "src/todos.fn": "export const addTodo = 1",
    },
    async (cwd) => {
      expect(await assertBunDevSupportsApp(appAt(cwd))).toBeUndefined()
    },
  )
})

test("refuses CSS Modules", async () => {
  await inTemp({ "src/x.module.css": ".a{}" }, async (cwd) => {
    const error = await assertBunDevSupportsApp(appAt(cwd)).catch((e: Error) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("CSS Modules")
    expect((error as Error).message).toContain("src/x.module.css")
    // It has to say what to do instead, or the refusal is just a wall.
    expect((error as Error).message).toContain("nifra dev")
  })
})

test("ignores build output and dependencies", async () => {
  // A `.module.css` inside node_modules or dist is not the app's source and must not block dev.
  await inTemp(
    {
      "node_modules/pkg/x.module.css": ".a{}",
      "dist/y.module.css": ".b{}",
      "src/app.ts": "export const app = 1",
    },
    async (cwd) => {
      expect(await assertBunDevSupportsApp(appAt(cwd))).toBeUndefined()
    },
  )
})
