import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import type { BrowserPage } from "./keep-alive-browser.ts"

/**
 * A keep-alive fixture served by the real `nifra dev`, for the development-only checks that only a
 * browser shows. Vite replaces `process.env.NODE_ENV` in the code it serves but leaves `process`
 * undefined, so a check that also asks for `process` passes every Bun-built test and never runs there.
 */
export interface DevApp {
  readonly origin: string
  stop(): Promise<void>
}

export async function serveDev(options: {
  /** The fixture directory to copy, routes and all. */
  readonly fixture: string
  /** Where the copy goes: under the adapter's test directory, so the workspace links resolve. */
  readonly under: string
  /** The `nifra.config.ts` source. */
  readonly config: string
  readonly pipeline: "vite" | "bun"
  /** Packages the fixture cannot resolve from `under`, each linked from the package directory given. */
  readonly links?: Readonly<Record<string, string>>
}): Promise<DevApp> {
  const dir = mkdtempSync(join(options.under, `.tmp-keep-alive-dev-${options.pipeline}-`))
  cpSync(options.fixture, dir, { recursive: true })
  writeFileSync(join(dir, "nifra.config.ts"), options.config)
  // A full Chrome asks for /favicon.ico (the headless shell never does), and its 404 is a console error.
  mkdirSync(join(dir, "public"), { recursive: true })
  writeFileSync(join(dir, "public", "favicon.ico"), "")
  for (const [name, target] of Object.entries(options.links ?? {})) {
    const link = join(dir, "node_modules", name)
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(target, link, "dir")
  }
  const cli = resolve(import.meta.dir, "../../cli/src/cli.ts")
  const args = ["dev", "--port", "0", ...(options.pipeline === "vite" ? ["--vite"] : [])]
  const dev = Bun.spawn([process.execPath, cli, ...args], {
    cwd: dir,
    env: { ...process.env, NODE_ENV: "development" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stop = async (): Promise<void> => {
    dev.kill()
    await dev.exited
    rmSync(dir, { recursive: true, force: true })
  }
  const reader = dev.stdout.getReader()
  const decoder = new TextDecoder()
  let banner = ""
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const port = /http:\/\/localhost:(\d+)/.exec(banner)?.[1]
    if (port !== undefined && banner.includes(`(${options.pipeline})`)) {
      reader.releaseLock()
      return { origin: `http://localhost:${port}`, stop }
    }
    const { value, done } = await reader.read()
    if (done) break
    banner += decoder.decode(value, { stream: true })
  }
  reader.releaseLock()
  const stderr = await new Response(dev.stderr).text()
  await stop()
  throw new Error(`no ${options.pipeline} dev server:\n${banner}\n--- stderr ---\n${stderr}`)
}

/** What `window.__nifraKeepAlive` lists, or `undefined` when the development build did not set it. */
export const keptPages = (page: BrowserPage): Promise<unknown> =>
  page.evaluate(() => {
    const source: unknown = Reflect.get(window, "__nifraKeepAlive")
    if (typeof source !== "object" || source === null) return undefined
    const pages: unknown = Reflect.get(source, "pages")
    return typeof pages === "function" ? pages() : undefined
  })
