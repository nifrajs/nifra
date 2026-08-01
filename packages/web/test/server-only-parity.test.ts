import { expect, test } from "bun:test"
import { serverOnlyEmptyPlugin } from "../src/build.ts"
import { viteServerOnlyReplacement } from "../src/internal/server-boundary.ts"
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

test("both pipelines remove a *.server module without retaining its implementation", async () => {
  const fromBun = await bunEmpty("/app/src/db.server.ts")
  const out = viteServerOnlyEmpty().transform(SOURCE, "/app/src/db.server.ts")
  if (out === null) throw new Error("the Vite plugin declined to transform a .server module")

  for (const replacement of [fromBun, out.code]) {
    expect(replacement).not.toContain("sk-live-do-not-ship")
    expect(replacement).not.toContain("node:fs")
  }
  // Vite dev serves native ESM, not the CommonJS body Bun.build consumes.
  expect(out.code).toContain("export const SECRET_TOKEN = undefined")
  expect(out.code).toContain("export default undefined")
})

test("the Vite replacement is valid browser ESM with inert source-derived exports", async () => {
  const out = viteServerOnlyEmpty().transform(SOURCE, "/a/db.server.ts")
  const url = `data:text/javascript;base64,${Buffer.from(out?.code ?? "").toString("base64")}`
  const module = (await import(url)) as Record<string, unknown>
  expect(module.SECRET_TOKEN).toBeUndefined()
  expect(module.default).toBeUndefined()
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
  expect(plugin.transform(SOURCE, "/a/db.server.ts", { ssr: true })).toBeNull()
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

/**
 * The export shapes the replacement derives its bindings from.
 *
 * The generator reads NAMES out of the source with a regex and emits `undefined` for each. That is
 * safe by construction - the output is built from names, never from source text, so no value can ride
 * along - but it is only *complete* for the shapes it recognises. What matters is which way the gaps
 * fail: a name it misses is a binding the module does not export, so the browser's ESM linker refuses
 * the import. Server code is never served as the fallback.
 */
const linkNames = (source: string): string[] => {
  const out = viteServerOnlyReplacement(source)
  return [...out.matchAll(/export (?:const (\w+)|(default))/g)].map((m) => m[1] ?? "default").sort()
}

test("bindings are derived from every export form the convention supports", () => {
  expect(linkNames(`export const A = 1\nexport function b() {}\nexport class C {}`)).toEqual([
    "A",
    "C",
    "b",
  ])
  expect(linkNames(`const a = 1\nexport { a }`)).toEqual(["a"])
  expect(linkNames(`const a = 1\nexport { a as renamed }`)).toEqual(["renamed"])
  expect(linkNames(`export { x } from "./other.ts"`)).toEqual(["x"])
  expect(linkNames(`const a = 1\nexport { a as default }`)).toEqual(["default"])
  expect(linkNames(`export default 1`)).toEqual(["default"])
  expect(linkNames(`export async function load() {}`)).toEqual(["load"])
  // `export type T` declares no runtime binding, so emitting one would invent an export the real
  // module never had. A `{ type U }` inside a value export list does get an inert binding - harmless,
  // and cheaper than parsing the list well enough to tell the two apart.
  expect(linkNames(`export type T = string\nexport { type U }`)).toEqual(["U"])
})

test("a shape it cannot read emits no binding, so the import fails rather than resolving", () => {
  // Each of these is legal server code the generator does not model. None may silently succeed with a
  // wrong value; all must simply not declare the name.
  expect(linkNames(`export * from "./secrets.ts"`)).toEqual([])
  expect(linkNames(`export const { a, b } = config`)).toEqual([])
  expect(linkNames(`export const a = 1, b = 2`)).toEqual(["a"]) // `b` is not modelled
})

test("no source text survives, whatever the shape", () => {
  const sources = [
    `const KEY = "sk-live-real"\nexport const TOKEN = KEY\nexport default { TOKEN }`,
    `export * from "./secrets.ts"`,
    `export const { apiKey } = process.env`,
    `import { readFileSync } from "node:fs"\nexport const cert = readFileSync("/etc/key.pem")`,
  ]
  for (const source of sources) {
    const out = viteServerOnlyReplacement(source)
    for (const secret of ["sk-live-real", "secrets", "process.env", "node:fs", "readFileSync"]) {
      expect(out).not.toContain(secret)
    }
    // Only inert bindings and the generated banner.
    for (const line of out.split("\n").filter((l) => l.trim() !== "" && !l.startsWith("//"))) {
      expect(line).toMatch(/^export (const \w+ = undefined|default undefined)$/)
    }
  }
})
