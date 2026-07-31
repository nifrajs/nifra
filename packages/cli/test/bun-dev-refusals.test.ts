import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SERVER_FN_MODULE, SERVER_ONLY_MODULE } from "@nifrajs/web"
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

/**
 * The guard and the transforms must agree on WHICH modules are server-only, for every extension the
 * conventions accept. They did not: the refusal was a hand-written glob `*.fn.{ts,tsx,js,jsx}` while
 * both build pipelines stub anything matching `/\.fn(\.[cm]?[jt]sx?)?$/` - so `.fn.mts`, `.fn.cts`,
 * `.fn.mjs` and `.fn.cjs` were stubbed by the builds and waved through by the guard, which is exactly
 * the leak the guard exists to prevent.
 *
 * These cases assert against the SHARED matchers, so widening a convention without widening the guard
 * fails here rather than in someone's browser.
 */
const EXTENSIONS = ["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"] as const
const stem = (path: string): string => path.replace(/\.[cm]?[jt]sx?$/, "")

test("refuses every extension the *.fn transform would stub", async () => {
  for (const ext of EXTENSIONS) {
    const rel = `src/todos.fn.${ext}`
    // Precondition: the transform really does consider this a server function.
    expect(SERVER_FN_MODULE.test(stem(rel))).toBe(true)
    await inTemp({ [rel]: "export const addTodo = 1" }, async (cwd) => {
      const error = await assertBunDevSupportsApp(appAt(cwd)).catch((e: Error) => e)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain(rel)
    })
  }
})

test("refuses every extension the *.server transform would empty", async () => {
  for (const ext of EXTENSIONS) {
    const rel = `src/db.server.${ext}`
    expect(SERVER_ONLY_MODULE.test(stem(rel))).toBe(true)
    await inTemp({ [rel]: 'export const KEY = "sk-live"' }, async (cwd) => {
      const error = await assertBunDevSupportsApp(appAt(cwd)).catch((e: Error) => e)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain(rel)
    })
  }
})

test("refuses extensionless *.server and *.fn modules", async () => {
  for (const [rel, message] of [
    ["src/db.server", "can't empty `*.server` modules"],
    ["src/todos.fn", "can't transform server functions"],
  ] as const) {
    await inTemp({ [rel]: 'export const SECRET = "sk-live"' }, async (cwd) => {
      const error = await assertBunDevSupportsApp(appAt(cwd)).catch((e: Error) => e)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain(message)
      expect((error as Error).message).toContain(rel)
    })
  }
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
