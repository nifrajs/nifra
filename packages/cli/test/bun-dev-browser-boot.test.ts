import { describe, expect, test } from "bun:test"
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { createFixtureRoot, removeFixtureRoot } from "./fixture-root.ts"
import { type ChromePage, findChrome, launchChrome } from "./headless-chrome.ts"

/**
 * `nifra dev`'s Bun pipeline can serve a page whose markup is right, whose client chunk is a 200, and
 * whose app still never boots: the chunk throws while it evaluates. That happened when the generated
 * `[serve.static]` boundary plugin carried an `onResolve` filter matching the probe page's
 * `<script src>` - Bun then wrote the raw specifier into the page's HMR module table, and the browser
 * reported "Failed to load bundled module" while every HTTP-level check stayed green. Only a browser evaluating the chunk sees it, so this loads the page in one and clicks.
 *
 * The match alone breaks it - a handler that declines does not help - so the same failure is open to any
 * plugin that reaches that bundler: the app's `clientPlugins` and its own bunfig `[serve.static]` entries
 * too, and such a plugin also stops the dev server from starting when it matches Bun's built-in React
 * refresh runtime. unplugin's Bun adapter, for one, registers `onResolve({ filter: /.*\/ })` for every
 * plugin with a `resolveId` hook.
 *
 * Without a Chrome the tests are skipped locally and FAIL in CI, so the guard cannot quietly vanish from
 * the pipeline that is supposed to run it.
 */
const chrome = findChrome()
if (chrome === undefined && process.env.CI !== undefined) {
  throw new Error(
    "bun-dev-browser-boot needs Chrome in CI: install one or set NIFRA_TEST_CHROME to its binary",
  )
}

/** A plugin whose resolve filter matches every specifier and declines every one, as unplugin's does. */
const CATCH_ALL_PLUGIN = [
  "{",
  '  name: "catch-all",',
  "  setup(build) {",
  "    build.onResolve({ filter: /.*/ }, () => undefined)",
  "  },",
  "}",
].join("\n")

const NIFRA_CONFIG = [
  'import { reactAdapter } from "@nifrajs/web-react"',
  "export const adapter = reactAdapter",
  'export const clientModule = "@nifrajs/web-react/client"',
]

/** Serve a one-counter app with `nifra dev`, load it in Chrome, and prove it hydrated by clicking. */
async function expectPageBoots(chrome: string, files: Record<string, string> = {}): Promise<void> {
  const root = createFixtureRoot("tmp-nifra-devboot-")
  let stopServer: (() => Promise<unknown>) | undefined
  let page: ChromePage | undefined
  try {
    mkdirSync(join(root, "routes"), { recursive: true })
    // Declared by the fixture itself rather than found by walking up into the monorepo root - see
    // bun-dev-css-modules.test.ts for why a fresh clone has no root `@nifrajs/` link farm.
    const nodeModules = join(root, "node_modules", "@nifrajs")
    mkdirSync(nodeModules, { recursive: true })
    for (const pkg of ["web", "web-react"]) {
      symlinkSync(resolve(import.meta.dir, "..", "..", pkg), join(nodeModules, pkg), "dir")
    }
    mkdirSync(join(root, "frontend"))
    const fixture: Record<string, string> = {
      "nifra.config.ts": NIFRA_CONFIG.join("\n"),
      "frontend/Counter.tsx": [
        'import { useState } from "react"',
        "export function Counter() {",
        "  const [count, setCount] = useState(0)",
        "  return (",
        '    <button id="inc" type="button" onClick={() => setCount((n) => n + 1)}>',
        "      count: {count}",
        "    </button>",
        "  )",
        "}",
      ].join("\n"),
      "routes/index.tsx": [
        'import { Counter } from "../frontend/Counter.tsx"',
        "export default function Home() {",
        "  return <Counter />",
        "}",
      ].join("\n"),
      ...files,
    }
    for (const [path, text] of Object.entries(fixture)) writeFileSync(join(root, path), text)

    const cli = resolve(import.meta.dir, "../src/cli.ts")
    const proc = Bun.spawn([process.execPath, cli, "dev", "--port", "0"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    })
    stopServer = () => {
      proc.kill()
      return proc.exited.catch(() => 0)
    }
    const reader = proc.stdout.getReader()
    let banner = ""
    const deadline = Date.now() + 60_000
    while (!/http:\/\/localhost:\d+/.test(banner) && Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      banner += new TextDecoder().decode(value)
    }
    if (!banner.includes("nifra dev (bun)")) {
      const stderr = await new Response(proc.stderr).text()
      throw new Error(
        `nifra dev printed no banner (exit ${await proc.exited}).\n--- stdout ---\n${banner}\n--- stderr ---\n${stderr}`,
      )
    }
    const port = Number(/http:\/\/localhost:(\d+)/.exec(banner)?.[1])
    expect(Number.isInteger(port)).toBe(true)

    page = await launchChrome(chrome)
    await page.goto(`http://127.0.0.1:${port}/`)
    await page.waitFor("document.documentElement.hasAttribute('data-nifra-hydrated')")
    // Hydrated is not yet interactive-by-proof: the click is the user-visible half of the contract.
    await page.evaluate("document.getElementById('inc').click()")
    await page.waitFor("document.getElementById('inc').textContent === 'count: 1'")
    expect(page.errors).toEqual([])
  } finally {
    await page?.close()
    await stopServer?.()
    removeFixtureRoot(root)
  }
}

describe.skipIf(chrome === undefined)(
  "nifra dev (bun): the client bundle boots in a real browser",
  () => {
    const browser = (): string => {
      if (chrome === undefined) throw new Error("unreachable: skipped without a Chrome")
      return chrome
    }

    test("with nifra's own boundary plugins", () => expectPageBoots(browser()), {
      timeout: 120_000,
    })

    test(
      "with an app clientPlugin whose resolve filter matches everything",
      () =>
        expectPageBoots(browser(), {
          "nifra.config.ts": [
            ...NIFRA_CONFIG,
            `export const clientPlugins = [${CATCH_ALL_PLUGIN}]`,
          ].join("\n"),
        }),
      { timeout: 120_000 },
    )

    test(
      "with a plugin from the app's own bunfig whose resolve filter matches everything",
      () =>
        expectPageBoots(browser(), {
          "bunfig.toml": '[serve.static]\nplugins = ["./catch-all-plugin.ts"]\n',
          "catch-all-plugin.ts": `export default ${CATCH_ALL_PLUGIN}\n`,
        }),
      { timeout: 120_000 },
    )
  },
)
