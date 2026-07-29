import { expect, test } from "bun:test"
import { serverOnlyEmptyPlugin } from "../src/build.ts"
import { viteServerOnlyEmpty } from "../src/plugins/vite-server-only.ts"

/**
 * The `.server` convention has to mean the same thing in every pipeline.
 *
 * It shipped as a `Bun.build` plugin only, so it held in exactly one of the four client paths:
 * `nifra build` emptied the module, while `nifra dev` (Vite), a Vite production build and
 * `nifra dev --bun` all bundled it whole. A guard that holds in one pipeline is worse than no guard,
 * because the file NAME reads as protection everywhere it appears.
 *
 * `nifra dev --bun` cannot be fixed with a plugin - Bun's dev bundler takes none - so it refuses to
 * start instead; that refusal is covered in the CLI's own tests. This covers the two that transform.
 */

const SOURCE = `import { readFileSync } from "node:fs"
export const SECRET_TOKEN = "sk-live-do-not-ship"
export default function readKey() { return readFileSync("/etc/key", "utf8") }
`

/** What Bun's plugin emits, driven through its real `onLoad` rather than reimplemented here. */
async function bunEmpty(filePath: string): Promise<string> {
  let onLoad: ((args: { path: string }) => { contents: string }) | undefined
  serverOnlyEmptyPlugin().setup({
    onLoad: (_filter: { filter: RegExp }, cb: (args: { path: string }) => { contents: string }) => {
      onLoad = cb
    },
    onResolve: () => {},
    config: {},
    module: () => {},
  } as never)
  if (onLoad === undefined) throw new Error("the Bun plugin registered no onLoad handler")
  return onLoad({ path: filePath }).contents
}

test("both pipelines empty a *.server module to byte-identical output", async () => {
  const fromBun = await bunEmpty("/app/src/db.server.ts")
  const out = viteServerOnlyEmpty().transform(SOURCE, "/app/src/db.server.ts")
  if (out === null) throw new Error("the Vite plugin declined to transform a .server module")

  expect(out.code).toBe(fromBun)
  // And it is genuinely emptied, not merely equal.
  expect(out.code).not.toContain("SECRET_TOKEN")
  expect(out.code).not.toContain("node:fs")
  expect(out.code).toContain("Proxy")
})

test("the emptied module yields undefined for any import shape", () => {
  const out = viteServerOnlyEmpty().transform(SOURCE, "/a/db.server.ts")
  const module = { exports: {} as Record<string, unknown> }
  new Function("module", out?.code ?? "")(module)
  // A named import, a default import, and something that never existed all resolve to undefined -
  // the client degrades where it wrote the call rather than failing the bundle with a missing export.
  expect(module.exports.SECRET_TOKEN).toBeUndefined()
  expect(module.exports.default).toBeUndefined()
  expect(module.exports.neverExisted).toBeUndefined()
})

test("it transforms only *.server modules, and survives a Vite id suffix", () => {
  const plugin = viteServerOnlyEmpty()
  const hit = (id: string): boolean => plugin.transform(SOURCE, id) !== null

  expect(hit("/a/db.server.ts")).toBe(true)
  expect(hit("/a/auth.server.tsx")).toBe(true)
  expect(hit("/a/x.server.mjs")).toBe(true)
  // Vite appends ?query / #hash to ids; the suffix must not hide the convention.
  expect(hit("/a/db.server.ts?v=abc123")).toBe(true)

  expect(hit("/a/db.ts")).toBe(false)
  expect(hit("/a/server.ts")).toBe(false)
  // A directory named `server` is not a server-only MODULE.
  expect(hit("/a/server/index.ts")).toBe(false)
  expect(hit("/a/observer.ts")).toBe(false)
})

test("it is registered for the client environment only", () => {
  // The SSR build must keep the real module - it is what actually runs server-side.
  const plugin = viteServerOnlyEmpty()
  expect(plugin.applyToEnvironment?.({ name: "client" })).toBe(true)
  expect(plugin.applyToEnvironment?.({ name: "ssr" })).toBe(false)
  expect(plugin.enforce).toBe("pre")
})

/**
 * Registration is the half that actually ships. A correct plugin nobody passes to Vite protects
 * nothing, and that is precisely how this convention came to hold in one pipeline out of four.
 */
test("both Vite pipelines register the plugin", async () => {
  const dev = await Bun.file(`${import.meta.dir}/../src/vite.ts`).text()
  const prod = await Bun.file(`${import.meta.dir}/../src/build-vite.ts`).text()
  for (const [name, src] of [
    ["vite.ts (dev server)", dev],
    ["build-vite.ts (production)", prod],
  ] as const) {
    expect(src, name).toContain("viteServerOnlyEmpty")
    // Registered in the plugin array, not merely imported.
    expect(src, name).toMatch(/plugins:\s*\[[^\]]*viteServerOnlyEmpty\(\)/)
  }
})
