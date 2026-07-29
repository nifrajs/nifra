import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assertBunDevSupportsApp } from "../src/cli.ts"

/**
 * `nifra dev --bun` is the one client pipeline that cannot transform anything: Bun's dev-server
 * bundler takes no plugins, so a module the other pipelines rewrite would ship here WHOLE.
 *
 * Two of these refusals guard secrets - a `*.fn` module holds function bodies, a `*.server` module is
 * server-only by name - so the failure mode of a missing refusal is a leak, not a broken page. None of
 * them had a test, which is how `.server` came to be enforced in one pipeline out of four.
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

test("refuses a *.server module, naming it", async () => {
  await inTemp({ "src/db.server.ts": 'export const KEY = "sk-live"' }, async (cwd) => {
    const error = await assertBunDevSupportsApp(appAt(cwd)).catch((e: Error) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("can't empty `*.server` modules")
    expect((error as Error).message).toContain("src/db.server.ts")
    // It has to say what to do instead, or the refusal is just a wall.
    expect((error as Error).message).toContain("nifra dev")
  })
})

test("refuses a *.fn module, naming it", async () => {
  await inTemp({ "src/todos.fn.ts": "export const addTodo = 1" }, async (cwd) => {
    const error = await assertBunDevSupportsApp(appAt(cwd)).catch((e: Error) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("can't transform server functions")
    expect((error as Error).message).toContain("src/todos.fn.ts")
  })
})

test("refuses CSS Modules", async () => {
  await inTemp({ "src/x.module.css": ".a{}" }, async (cwd) => {
    const error = await assertBunDevSupportsApp(appAt(cwd)).catch((e: Error) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("CSS Modules")
    expect((error as Error).message).toContain("src/x.module.css")
  })
})

test("ignores build output and dependencies", async () => {
  // A `.server` module inside node_modules or dist is not the app's source and must not block dev.
  await inTemp(
    {
      "node_modules/pkg/db.server.ts": "export const x = 1",
      "dist/db.server.ts": "export const x = 1",
      "src/app.ts": "export const app = 1",
    },
    async (cwd) => {
      expect(await assertBunDevSupportsApp(appAt(cwd))).toBeUndefined()
    },
  )
})
