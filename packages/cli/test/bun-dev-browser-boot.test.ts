import { expect, test } from "bun:test"
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { createFixtureRoot, removeFixtureRoot } from "./fixture-root.ts"
import { type ChromePage, findChrome, launchChrome } from "./headless-chrome.ts"

/**
 * `nifra dev`'s Bun pipeline can serve a page whose markup is right, whose client chunk is a 200, and
 * whose app still never boots: the chunk throws while it evaluates. That happened when the generated
 * `[serve.static]` boundary plugin carried an `onResolve` filter matching the probe page's
 * `<script src="./entry.tsx">` - Bun then wrote the raw specifier into the page's HMR module table, and
 * the browser reported "Failed to load bundled module './entry.tsx'" while every HTTP-level check
 * stayed green. Only a browser evaluating the chunk sees it, so this loads the page in one and clicks.
 *
 * Without a Chrome the test is skipped locally and FAILS in CI, so the guard cannot quietly vanish from
 * the pipeline that is supposed to run it.
 */
const chrome = findChrome()
if (chrome === undefined && process.env.CI !== undefined) {
  throw new Error(
    "bun-dev-browser-boot needs Chrome in CI: install one or set NIFRA_TEST_CHROME to its binary",
  )
}

test.skipIf(chrome === undefined)(
  "nifra dev (bun): the client bundle boots in a real browser and hydrates the page",
  async () => {
    if (chrome === undefined) throw new Error("unreachable: skipped without a Chrome")
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
      writeFileSync(
        join(root, "nifra.config.ts"),
        [
          'import { reactAdapter } from "@nifrajs/web-react"',
          "export const adapter = reactAdapter",
          'export const clientModule = "@nifrajs/web-react/client"',
        ].join("\n"),
      )
      writeFileSync(
        join(root, "frontend", "Counter.tsx"),
        [
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
      )
      writeFileSync(
        join(root, "routes", "index.tsx"),
        [
          'import { Counter } from "../frontend/Counter.tsx"',
          "export default function Home() {",
          "  return <Counter />",
          "}",
        ].join("\n"),
      )

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
  },
  { timeout: 120_000 },
)
