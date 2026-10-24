import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  assertDirectChildCssDiagnostic,
  installedEngines,
  openPage,
} from "../../web/test/keep-alive-browser.ts"

/**
 * The development-only keep-alive checks through the real `nifra dev` pipelines. Vite replaces
 * `process.env.NODE_ENV` in the code it serves the browser but leaves `process` itself undefined, so a
 * check gated on `typeof process` never ran there, while every Bun-built test passed.
 */
const chromium = (await installedEngines()).find((engine) => engine.name === "chromium")

for (const pipeline of ["vite", "bun"] as const) {
  describe(`nifra dev (${pipeline})`, () => {
    const dir = mkdtempSync(join(import.meta.dir, `.tmp-keep-alive-dev-${pipeline}-`))
    let origin: string | undefined
    let dev: ReturnType<typeof Bun.spawn> | undefined

    beforeAll(async () => {
      if (chromium === undefined) return
      cpSync(join(import.meta.dir, "fixtures/keep-alive"), dir, { recursive: true })
      writeFileSync(
        join(dir, "nifra.config.ts"),
        [
          'import { reactAdapter } from "@nifrajs/web-react"',
          "export const adapter = reactAdapter",
          'export const clientModule = "@nifrajs/web-react/client"',
        ].join("\n"),
      )
      const cli = resolve(import.meta.dir, "../../cli/src/cli.ts")
      const spawned = Bun.spawn(
        [process.execPath, cli, "dev", "--port", "0", ...(pipeline === "vite" ? ["--vite"] : [])],
        {
          cwd: dir,
          env: { ...process.env, NODE_ENV: "development" },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      dev = spawned
      const reader = spawned.stdout.getReader()
      const decoder = new TextDecoder()
      let banner = ""
      const deadline = Date.now() + 60_000
      while (origin === undefined && Date.now() < deadline) {
        const { value, done } = await reader.read()
        if (done) break
        banner += decoder.decode(value, { stream: true })
        const port = /http:\/\/localhost:(\d+)/.exec(banner)?.[1]
        if (port !== undefined) origin = `http://localhost:${port}`
      }
      reader.releaseLock()
      if (origin === undefined || !banner.includes(`(${pipeline})`)) {
        const stderr = await new Response(spawned.stderr).text()
        throw new Error(`no ${pipeline} dev server:\n${banner}\n--- stderr ---\n${stderr}`)
      }
    }, 90_000)

    afterAll(async () => {
      dev?.kill()
      await dev?.exited
      rmSync(dir, { recursive: true, force: true })
    })

    test.skipIf(chromium === undefined)(
      "lists kept pages for devtools and reports a direct-child selector",
      async () => {
        if (chromium === undefined || origin === undefined) throw new Error("[test] no server")
        const browser = await chromium.launch()
        try {
          const { page, problems } = await openPage(browser)
          await assertDirectChildCssDiagnostic(page, problems, origin)
          const kept = await page.evaluate(() => {
            const source: unknown = Reflect.get(window, "__nifraKeepAlive")
            if (typeof source !== "object" || source === null) return undefined
            const pages: unknown = Reflect.get(source, "pages")
            return typeof pages === "function" ? pages() : undefined
          })
          expect(kept).toEqual([
            expect.objectContaining({ path: "/list/2", nodes: expect.any(Number) }),
          ])
          expect(problems.filter((problem) => !problem.includes("NIFRA_KEEPALIVE"))).toEqual([])
          await page.close()
        } finally {
          await browser.close()
        }
      },
      60_000,
    )
  })
}
