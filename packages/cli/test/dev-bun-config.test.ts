import { expect, test } from "bun:test"
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import {
  consumeLaunchToken,
  parseUserBunfig,
  renderBoundaryPluginModule,
  renderDevBunfig,
  serializeBunfig,
  writeBunDevConfig,
} from "../src/dev-bun-config.ts"
import { createFixtureRoot, removeFixtureRoot } from "./fixture-root.ts"

/**
 * The `nifra dev --bun` boundary-plugin channel: a generated bunfig delivers the production
 * client-boundary + CSS Modules plugins to Bun's dev-server bundler via `[serve.static] plugins` - the only
 * channel that bundler accepts plugins through. These tests pin the config carry-over (the WHOLE
 * user bunfig round-trips), the merge semantics, the per-launch token that makes the child
 * detection unforgeable, and then prove the mechanism END TO END: a real `Bun.serve` HTML-import
 * dev server started with the generated config must serve the server-function STUB, never the
 * module body - the leak the old refusal guarded against.
 */

/**
 * The fixture server every bundling test spawns: import the HTML bundle, serve it on an ephemeral
 * port, print the port. This is EMITTED SOURCE, not code that runs here - the `${s.port}` inside it
 * belongs to the template literal in the file being written, which is why it is a plain string.
 */
const SERVE_FIXTURE = `import html from "./index.html"
const s = Bun.serve({ port: 0, routes: { "/": html }, development: true })
console.log(\`PORT=\${s.port}\`)
`

/** Read the `PORT=<n>` banner a spawned fixture server prints. The fixtures listen on port 0 so
 * concurrent runs (and anything already bound on this machine) can never collide. */
async function readPort(proc: ReturnType<typeof Bun.spawn>): Promise<number> {
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
  return port
}

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
  expect(source).toContain('from "@nifrajs/web/plugins/css-modules"')
  expect(source).toContain("serverFnStubPlugin")
  expect(source).toContain("serverOnlyEmptyPlugin")
  expect(source).toContain('cssModulesBunPlugin("dom")')
  expect(source).toContain("cssModules.setup(build)")
})

test("the generated plugin module composes the app's own clientPlugins, by relative specifier", () => {
  const source = renderBoundaryPluginModule("/app/nifra.config.ts", "/app/.nifra/dev-bun")
  // Relative, not absolute: the module has to resolve the config the way any file in the app would.
  expect(source).toContain('import * as appConfig from "../../nifra.config.ts"')
  expect(source).toContain("appConfig.clientPlugins")
  // Without a config path there is nothing to compose in, and the module must not reference one.
  expect(renderBoundaryPluginModule()).not.toContain("appConfig")
})

test("launch token: only the fresh parent-minted value verifies, exactly once", async () => {
  const root = createFixtureRoot("tmp-nifra-devbun-token-")
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
    removeFixtureRoot(root)
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
    const root = createFixtureRoot("tmp-nifra-devbun-")
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
      writeFileSync(join(root, "serve.ts"), SERVE_FIXTURE)

      const { bunfigPath } = await writeBunDevConfig(root)
      proc = Bun.spawn(["bun", `--config=${bunfigPath}`, join(root, "serve.ts")], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      })
      const port = await readPort(proc)

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
      removeFixtureRoot(root)
    }
  },
  { timeout: 30_000 },
)

test(
  "a dev server started with the generated bunfig compiles CSS Modules and serves their stylesheet",
  async () => {
    const root = createFixtureRoot("tmp-nifra-devbun-css-")
    let proc: ReturnType<typeof Bun.spawn> | undefined
    try {
      const webPkg = resolve(import.meta.dir, "../../web")
      mkdirSync(join(root, "node_modules", "@nifrajs"), { recursive: true })
      symlinkSync(webPkg, join(root, "node_modules", "@nifrajs", "web"))

      writeFileSync(join(root, "styles.module.css"), ".card { color: rebeccapurple }\n")
      writeFileSync(
        join(root, "client.ts"),
        'import styles from "./styles.module.css"\ndocument.body.dataset.className = styles.card\n',
      )
      writeFileSync(
        join(root, "index.html"),
        '<!doctype html><html><body><script type="module" src="./client.ts"></script></body></html>\n',
      )
      writeFileSync(join(root, "serve.ts"), SERVE_FIXTURE)

      const { bunfigPath } = await writeBunDevConfig(root)
      proc = Bun.spawn(["bun", `--config=${bunfigPath}`, join(root, "serve.ts")], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      })
      const port = await readPort(proc)

      const page = await (await fetch(`http://127.0.0.1:${port}/`)).text()
      const script = /<script[^>]+src="([^"]+\.js)"/.exec(page)?.[1]
      const stylesheet = /<link[^>]+rel="stylesheet"[^>]+href="([^"]+\.css)"/.exec(page)?.[1]
      expect(script).toBeDefined()
      expect(stylesheet).toBeDefined()
      const js = await (await fetch(`http://127.0.0.1:${port}${script}`)).text()
      const css = await (await fetch(`http://127.0.0.1:${port}${stylesheet}`)).text()
      expect(js).toContain("card_")
      expect(css).toContain(".card_")
      expect(css).toMatch(/(?:rebeccapurple|#639)/)
    } finally {
      proc?.kill()
      removeFixtureRoot(root)
    }
  },
  { timeout: 30_000 },
)

test(
  "a dev server started with the generated bunfig runs the APP's own clientPlugins",
  async () => {
    // The CLI holds `clientPlugins` as plugin OBJECTS, and bunfig accepts only module PATHS - so the
    // generated module re-imports the app's config to compose them in. Without this an app whose only
    // transforms are `clientPlugins` had no Bun dev loop at all. This proves the whole chain works
    // through `[serve.static]`, including the async `setup` the thunk form needs.
    const root = createFixtureRoot("tmp-nifra-devbun-appplugin-")
    let proc: ReturnType<typeof Bun.spawn> | undefined
    try {
      const webPkg = resolve(import.meta.dir, "../../web")
      mkdirSync(join(root, "node_modules", "@nifrajs"), { recursive: true })
      symlinkSync(webPkg, join(root, "node_modules", "@nifrajs", "web"))

      const configPath = join(root, "nifra.config.ts")
      writeFileSync(
        configPath,
        [
          "const marker = {",
          '  name: "app-marker",',
          "  setup(build) {",
          "    build.onLoad({ filter: /marker\\.ts$/ }, () => ({",
          '      loader: "ts",',
          "      contents: 'export const M = \"TRANSFORMED_BY_APP_PLUGIN\"',",
          "    }))",
          // A hostile/careless app plugin claiming a `*.server` module too. The boundary registers
          // first, so it wins the load and this never gets to put the secret back in the bundle.
          "    build.onLoad({ filter: /\\.server\\.ts$/ }, () => ({",
          '      loader: "ts",',
          "      contents: 'export const API_KEY = \"SERVER_ONLY_SECRET_ABC\"',",
          "    }))",
          "  },",
          "}",
          // The thunk form, deliberately: it is the one that needs `setup` to be able to await.
          "export const clientPlugins = () => [marker]",
        ].join("\n"),
      )
      writeFileSync(join(root, "marker.ts"), 'export const M = "ORIGINAL_UNTRANSFORMED"\n')
      writeFileSync(
        join(root, "config.server.ts"),
        'export const API_KEY = "SERVER_ONLY_SECRET_ABC"\n',
      )
      writeFileSync(
        join(root, "client.ts"),
        'import { M } from "./marker.ts"\nimport * as cfg from "./config.server.ts"\nconsole.log(M, cfg)\n',
      )
      writeFileSync(
        join(root, "index.html"),
        '<!doctype html><html><body><script type="module" src="./client.ts"></script></body></html>\n',
      )
      writeFileSync(join(root, "serve.ts"), SERVE_FIXTURE)

      const { bunfigPath } = await writeBunDevConfig(root, configPath)
      proc = Bun.spawn(["bun", `--config=${bunfigPath}`, join(root, "serve.ts")], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      })
      const port = await readPort(proc)
      const page = await (await fetch(`http://127.0.0.1:${port}/`)).text()
      const script = /<script[^>]+src="([^"]+\.js)"/.exec(page)?.[1]
      expect(script).toBeDefined()
      const js = await (await fetch(`http://127.0.0.1:${port}${script}`)).text()
      expect(js).toContain("TRANSFORMED_BY_APP_PLUGIN")
      expect(js).not.toContain("ORIGINAL_UNTRANSFORMED")
      // The boundary is not negotiable: an app plugin cannot re-introduce a `*.server` module's body.
      expect(js).not.toContain("SERVER_ONLY_SECRET_ABC")
    } finally {
      proc?.kill()
      removeFixtureRoot(root)
    }
  },
  { timeout: 30_000 },
)

test("writeBunDevConfig merges the app's own bunfig", async () => {
  const root = createFixtureRoot("tmp-nifra-devbun-merge-")
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
    removeFixtureRoot(root)
  }
})
