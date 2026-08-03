import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import {
  consumeLaunchToken,
  parseUserBunfig,
  renderBoundaryPluginModule,
  renderDevBunfig,
  serializeBunfig,
  writeBunDevConfig,
} from "../src/dev-bun-config.ts"

/**
 * The `nifra dev --bun` boundary-plugin channel: a generated bunfig delivers the production
 * client-boundary plugins to Bun's dev-server bundler via `[serve.static] plugins` - the only
 * channel that bundler accepts plugins through. These tests pin the config carry-over (the WHOLE
 * user bunfig round-trips), the merge semantics, the per-launch token that makes the child
 * detection unforgeable, and then prove the mechanism END TO END: a real `Bun.serve` HTML-import
 * dev server started with the generated config must serve the server-function STUB, never the
 * module body - the leak the old refusal guarded against.
 */

test("parseUserBunfig: absent is empty, malformed fails loudly", () => {
  expect(parseUserBunfig(undefined)).toEqual({})
  expect(() => parseUserBunfig("not [ valid toml")).toThrow(/bunfig\.toml does not parse/)
})

test("the user's ENTIRE bunfig round-trips - not just the two fields the merge touches", () => {
  const user = parseUserBunfig(
    [
      'preload = ["./setup.ts"]',
      "[jsx]",
      'factory = "h"',
      "[define]",
      '"process.env.FLAG" = "true"',
      "[install]",
      'registry = "https://registry.example.com"',
      "[serve.static]",
      'plugins = ["bun-plugin-tailwind"]',
    ].join("\n"),
  )
  const toml = renderDevBunfig("/app/.nifra/dev-bun/boundary-plugin.ts", user, "/app")
  // Every original setting survives; dropping one would run dev on different Bun settings.
  expect(toml).toContain('factory = "h"')
  expect(toml).toContain('"process.env.FLAG" = "true"')
  expect(toml).toContain('registry = "https://registry.example.com"')
  expect(toml).toContain('preload = ["/app/setup.ts"]')
  expect(toml).toContain(
    'plugins = ["/app/.nifra/dev-bun/boundary-plugin.ts", "bun-plugin-tailwind"]',
  )
  // And the emitted TOML parses back to the same data (plus the plugin merge).
  const reparsed = parseUserBunfig(toml)
  expect((reparsed.jsx as Record<string, unknown>).factory).toBe("h")
})

test("serializeBunfig refuses a shape it cannot round-trip instead of dropping it", () => {
  expect(() => serializeBunfig({ weird: [{ nested: true }] })).toThrow(/cannot re-serialize/)
})

test("renderDevBunfig without a user bunfig still emits the boundary plugin", () => {
  const toml = renderDevBunfig("/app/.nifra/dev-bun/boundary-plugin.ts", {}, "/app")
  expect(toml).toContain('plugins = ["/app/.nifra/dev-bun/boundary-plugin.ts"]')
})

test("the generated plugin module composes the PRODUCTION boundary plugins, not a re-implementation", () => {
  const source = renderBoundaryPluginModule()
  expect(source).toContain('from "@nifrajs/web/build"')
  expect(source).toContain("serverFnStubPlugin")
  expect(source).toContain("serverOnlyEmptyPlugin")
})

test("launch token: only the fresh parent-minted value verifies, exactly once", async () => {
  const root = mkdtempSync(join(import.meta.dir, ".tmp-nifra-devbun-token-"))
  try {
    const { launchToken } = await writeBunDevConfig(root)
    // A fixed/guessed value - the S-02 bypass shape - must NOT verify (and consumes the file).
    expect(consumeLaunchToken(root, "1")).toBe(false)
    expect(consumeLaunchToken(root, launchToken)).toBe(false) // already consumed - fail closed
    const second = await writeBunDevConfig(root)
    expect(consumeLaunchToken(root, second.launchToken)).toBe(true)
    // One-shot: the same real token cannot verify twice (stale env vars die here).
    expect(consumeLaunchToken(root, second.launchToken)).toBe(false)
    expect(consumeLaunchToken(root, undefined)).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
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
