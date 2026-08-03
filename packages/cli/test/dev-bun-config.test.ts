import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import {
  renderBoundaryPluginModule,
  renderDevBunfig,
  userBunfigSlice,
  writeBunDevConfig,
} from "../src/dev-bun-config.ts"

/**
 * The `nifra dev --bun` boundary-plugin channel: a generated bunfig delivers the production
 * client-boundary plugins to Bun's dev-server bundler via `[serve.static] plugins` - the only
 * channel that bundler accepts plugins through. These tests pin the config generation (merge
 * semantics, path resolution) and then prove the whole mechanism END TO END: a real `Bun.serve`
 * HTML-import dev server started with the generated config must serve the server-function STUB,
 * never the module body - the leak the old refusal guarded against.
 */

test("userBunfigSlice: absent, malformed, and populated bunfigs", () => {
  expect(userBunfigSlice(undefined)).toEqual({ preload: [], serveStaticPlugins: [] })
  expect(userBunfigSlice("not [ valid toml")).toEqual({ preload: [], serveStaticPlugins: [] })
  const slice = userBunfigSlice(
    ['preload = ["./setup.ts"]', "[serve.static]", 'plugins = ["bun-plugin-tailwind"]'].join("\n"),
  )
  expect(slice).toEqual({ preload: ["./setup.ts"], serveStaticPlugins: ["bun-plugin-tailwind"] })
  // The string (non-array) preload form bunfig accepts.
  expect(userBunfigSlice('preload = "./one.ts"').preload).toEqual(["./one.ts"])
})

test("renderDevBunfig: boundary plugin first, user entries carried and resolved", () => {
  const toml = renderDevBunfig(
    "/app/.nifra/dev-bun/boundary-plugin.ts",
    { preload: ["./setup.ts"], serveStaticPlugins: ["bun-plugin-tailwind", "./local-plugin.ts"] },
    "/app",
  )
  // Ours first, package specifiers untouched, relative user entries re-rooted at the APP (bunfig
  // resolves relative entries against the config file's own directory, which is .nifra/dev-bun/).
  expect(toml).toContain(
    'plugins = ["/app/.nifra/dev-bun/boundary-plugin.ts", "bun-plugin-tailwind", "/app/local-plugin.ts"]',
  )
  expect(toml).toContain('preload = ["/app/setup.ts"]')
})

test("the generated plugin module composes the PRODUCTION boundary plugins, not a re-implementation", () => {
  const source = renderBoundaryPluginModule()
  expect(source).toContain('from "@nifrajs/web/build"')
  expect(source).toContain("serverFnStubPlugin")
  expect(source).toContain("serverOnlyEmptyPlugin")
})

/**
 * End to end: generated config + real Bun.serve dev bundling. The fixture app gets a node_modules
 * symlink to this workspace's @nifrajs/web so the generated plugin module resolves exactly as it
 * would in a user app. The served client chunk must contain the RPC stub and must NOT contain the
 * secret - in either the `*.fn` or the `*.server` direction.
 */
test(
  "a dev server started with the generated bunfig strips *.fn and *.server from the client",
  async () => {
    const root = mkdtempSync(join(import.meta.dir, ".tmp-nifra-devbun-"))
    let proc: ReturnType<typeof Bun.spawn> | undefined
    try {
      const webPkg = resolve(import.meta.dir, "../../web")
      mkdirSync(join(root, "node_modules", "@nifrajs"), { recursive: true })
      symlinkSync(webPkg, join(root, "node_modules", "@nifrajs", "web"))

      writeFileSync(
        join(root, "secret.fn.ts"),
        'export const DB_SECRET = "FN_SECRET_VALUE_XYZ"\nexport function charge(): string { return DB_SECRET }\n',
      )
      writeFileSync(
        join(root, "config.server.ts"),
        'export const API_KEY = "SERVER_ONLY_SECRET_ABC"\n',
      )
      writeFileSync(
        join(root, "client.ts"),
        'import { charge } from "./secret.fn.ts"\nimport * as cfg from "./config.server.ts"\nconsole.log(charge(), cfg)\n',
      )
      writeFileSync(
        join(root, "index.html"),
        '<!doctype html><html><body><script type="module" src="./client.ts"></script></body></html>\n',
      )
      writeFileSync(
        join(root, "serve.ts"),
        [
          'import html from "./index.html"',
          'const s = Bun.serve({ port: 0, routes: { "/": html }, development: true })',
          "console.log(`PORT=${s.port}`)",
        ].join("\n"),
      )

      const { bunfigPath } = await writeBunDevConfig(root)
      proc = Bun.spawn(["bun", `--config=${bunfigPath}`, join(root, "serve.ts")], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      })
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
      let banner = ""
      const deadline = Date.now() + 15_000
      while (!banner.includes("PORT=") && Date.now() < deadline) {
        const { value, done } = await reader.read()
        if (done) break
        banner += new TextDecoder().decode(value)
      }
      const port = Number(/PORT=(\d+)/.exec(banner)?.[1])
      expect(Number.isInteger(port)).toBe(true)

      const html = await (await fetch(`http://127.0.0.1:${port}/`)).text()
      const chunk = /\/_bun\/[^"]+\.js/.exec(html)?.[0]
      expect(chunk).toBeDefined()
      const js = await (await fetch(`http://127.0.0.1:${port}${chunk}`)).text()

      // The *.fn body is replaced with the RPC stub; the *.server module is emptied.
      expect(js).not.toContain("FN_SECRET_VALUE_XYZ")
      expect(js).not.toContain("SERVER_ONLY_SECRET_ABC")
      // Positive signal that the stub (not an empty bundle) shipped: the RPC path the production
      // stub calls appears in the chunk.
      expect(js).toContain("/fn/")
    } finally {
      proc?.kill()
      rmSync(root, { recursive: true, force: true })
    }
  },
  { timeout: 30_000 },
)

test("writeBunDevConfig merges the app's own bunfig", async () => {
  const root = mkdtempSync(join(import.meta.dir, ".tmp-nifra-devbun-merge-"))
  try {
    writeFileSync(
      join(root, "bunfig.toml"),
      ["[serve.static]", 'plugins = ["bun-plugin-tailwind"]'].join("\n"),
    )
    const { bunfigPath } = await writeBunDevConfig(root)
    const generated = await Bun.file(bunfigPath).text()
    expect(generated).toContain("boundary-plugin.ts")
    expect(generated).toContain("bun-plugin-tailwind")
    // Ours must come first so the boundary is stripped before any user transform runs.
    expect(generated.indexOf("boundary-plugin.ts")).toBeLessThan(
      generated.indexOf("bun-plugin-tailwind"),
    )
    expect(dirname(bunfigPath)).toBe(resolve(root, ".nifra", "dev-bun"))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
