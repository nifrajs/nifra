import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import type { BunPlugin } from "bun"
import { buildClient, generateServerEntry, resyncServerManifestSource } from "../src/build.ts"
import type { BuildManifest } from "../src/build-plan.ts"
import { buildClientVite } from "../src/build-vite.ts"
import { discoverRoutes } from "../src/fs.ts"
import { generateClientEntry, generateServerManifest, renderPageResult } from "../src/index.ts"
import { loadCopySplit } from "../src/internal/copy-split.ts"
import { readSource } from "../src/plugins/kit.ts"
import { COPY_CHUNKS_GLOBAL, COPY_REALM, type RenderAdapter } from "../src/render-seam.ts"

// Inside the workspace, so the fixture resolves `@nifrajs/i18n` and `typescript` as an app would.
const root = mkdtempSync(`${import.meta.dir}/.tmp-copy-split-`)
afterAll(() => rmSync(root, { recursive: true, force: true }))

const write = (file: string, text: string): void => {
  mkdirSync(dirname(join(root, file)), { recursive: true })
  writeFileSync(join(root, file), text)
}

const SCRIPTS = {
  devanagari: /[\u0900-\u097F]/,
  tamil: /[\u0B80-\u0BFF]/,
  arabic: /[\u0600-\u06FF]/,
} as const
// A minifier may write a non-ASCII character as an escape; read both.
const unescaped = (text: string): string =>
  text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  )
const scriptsFound = (text: string): string[] =>
  Object.entries(SCRIPTS)
    .filter(([, pattern]) => pattern.test(unescaped(text)))
    .map(([name]) => name)

let manifest: BuildManifest
const outDir = join(root, "dist")

beforeAll(async () => {
  write(
    "shared/i18n.ts",
    [
      'import { defineLocales } from "@nifrajs/i18n"',
      'import { defineCopy } from "@nifrajs/i18n/copy"',
      'export const locales = defineLocales({ default: "en", locales: { en: {}, hi: {}, ta: {}, ar: {} } })',
      "export const copy = defineCopy(locales)",
    ].join("\n"),
  )
  write(
    "routes/index.tsx",
    [
      'import { copy } from "../shared/i18n"',
      'export const TITLE = copy({ en: "Bicycle", hi: "साइकिल", ta: "மிதிவண்டி", ar: "دراجة" })',
      'export const FAQ = copy.id("shop.faq", { en: ["Brakes?"], hi: ["ब्रेक?"] })',
      'export default function Index() { return copy.pick(TITLE, "en") }',
    ].join("\n"),
  )
  write(
    "shared/labels.ts",
    [
      'import { copy } from "./i18n"',
      'export const SADDLE = copy({ en: "Saddle", hi: "काठी", ta: "சேணம்", ar: "سرج" })',
    ].join("\n"),
  )
  write(
    "routes/about.tsx",
    'import { SADDLE } from "../shared/labels"\nexport default function About() { return String(SADDLE) }\n',
  )
  write("frontend/client-stub.ts", "export function mountRouter() {}\n")
  manifest = await buildClient({
    routesDir: join(root, "routes"),
    outDir,
    clientModule: join(root, "frontend/client-stub.ts"),
    publicDir: false,
  })
}, 60_000)

describe("a production client build with copy tables", () => {
  test("writes one chunk per locale and lists them in the manifest", () => {
    const chunks = manifest.copyChunks ?? {}
    expect(Object.keys(chunks).sort()).toEqual(["ar", "en", "hi", "ta"])
    const hi: unknown = Reflect.get(Object(chunks), "hi")
    expect(readFileSync(join(outDir, String(hi).replace("/assets/", "")), "utf8")).toContain("काठी")
    for (const url of Object.values(chunks)) {
      expect(url).toMatch(/^\/assets\/copy-[a-z]+-[0-9a-f]{12}\.js$/)
      expect(manifest.assets).toContain(url)
    }
  })

  test("a /hi/ page's JavaScript carries no Tamil or Arabic copy", () => {
    const names = readdirSync(outDir).filter((name) => name.endsWith(".js"))
    const code = names.filter((name) => !name.startsWith("copy-"))
    expect(code.length).toBeGreaterThan(0)
    for (const name of code)
      expect(scriptsFound(readFileSync(join(outDir, name), "utf8"))).toEqual([])
    const hi = readFileSync(
      join(outDir, (manifest.copyChunks?.hi ?? "").replace("/assets/", "")),
      "utf8",
    )
    expect(scriptsFound(hi)).toEqual(["devanagari"])
  })

  test("a plugin that claims a module and reads it through readSource gets it split", async () => {
    const claimedDir = join(root, "dist-claimed")
    const claimed: string[] = []
    const claiming: BunPlugin = {
      name: "claims-index",
      setup(build) {
        build.onLoad({ filter: /routes[\\/]index\.tsx$/ }, async (args) => {
          claimed.push(args.path)
          return { contents: await readSource(build, args.path), loader: "tsx" }
        })
      },
    }
    const built = await buildClient({
      routesDir: join(root, "routes"),
      outDir: claimedDir,
      clientModule: join(root, "frontend/client-stub.ts"),
      publicDir: false,
      plugins: [claiming],
    })
    expect(claimed).toHaveLength(1)
    expect(Object.keys(built.copyChunks ?? {}).sort()).toEqual(["ar", "en", "hi", "ta"])
    const code = readdirSync(claimedDir)
      .filter((name) => name.endsWith(".js") && !name.startsWith("copy-"))
      .map((name) => readFileSync(join(claimedDir, name), "utf8"))
      .join("\n")
    expect(scriptsFound(code)).toEqual([])
  })

  test("a module with tables and an import.meta.glob is split and expanded both", async () => {
    const app = join(root, "globbed")
    const put = (file: string, text: string): void => {
      mkdirSync(dirname(join(app, file)), { recursive: true })
      writeFileSync(join(app, file), text)
    }
    put("shared/i18n.ts", readFileSync(join(root, "shared/i18n.ts"), "utf8"))
    put(
      "shared/parts.ts",
      [
        'import { copy } from "./i18n"',
        'export const PEDAL = copy({ en: "Pedal", hi: "पैडल", ta: "மிதி", ar: "دواسة" })',
        'export const kinds = import.meta.glob("./kinds/*.ts", { eager: true, import: "default" })',
      ].join("\n"),
    )
    put("shared/kinds/road.ts", 'export default "kind-road"\n')
    put(
      "routes/index.tsx",
      'import { PEDAL, kinds } from "../shared/parts"\nexport default function Index() { return String(PEDAL) + Object.values(kinds).join() }\n',
    )
    put("frontend/client-stub.ts", "export function mountRouter() {}\n")
    const globbedDir = join(app, "dist")
    const built = await buildClient({
      routesDir: join(app, "routes"),
      outDir: globbedDir,
      clientModule: join(app, "frontend/client-stub.ts"),
      publicDir: false,
    })
    expect(Object.keys(built.copyChunks ?? {}).sort()).toEqual(["ar", "en", "hi", "ta"])
    const code = readdirSync(globbedDir)
      .filter((name) => name.endsWith(".js") && !name.startsWith("copy-"))
      .map((name) => readFileSync(join(globbedDir, name), "utf8"))
      .join("\n")
    expect(code).toContain("kind-road")
    expect(scriptsFound(code)).toEqual([])
  }, 60_000)

  test("with the split off, every locale's copy is in the route's code", async () => {
    const unsplitDir = join(root, "dist-unsplit")
    const unsplit = await buildClient({
      routesDir: join(root, "routes"),
      outDir: unsplitDir,
      clientModule: join(root, "frontend/client-stub.ts"),
      publicDir: false,
      copySplit: false,
    })
    expect(unsplit.copyChunks).toBeUndefined()
    const code = readdirSync(unsplitDir)
      .filter((name) => name.endsWith(".js"))
      .map((name) => readFileSync(join(unsplitDir, name), "utf8"))
      .join("\n")
    expect(scriptsFound(code)).toEqual(["devanagari", "tamil", "arabic"])
    const entry = readFileSync(join(unsplitDir, unsplit.entry.replace("/assets/", "")), "utf8")
    expect(entry).not.toContain(COPY_CHUNKS_GLOBAL)
    expect(entry).not.toContain(".prepare(")
  })

  test("a locale without a value carries the fallback's, marked for onMissing", async () => {
    const file = join(outDir, (manifest.copyChunks?.ta ?? "").replace("/assets/", ""))
    const ta: unknown = Reflect.get(Object(await import(pathToFileURL(file).href)), "default")
    expect(Object.values(Reflect.get(Object(ta), "v"))).toContainEqual(["Brakes?"])
    expect(Object.values(Reflect.get(Object(ta), "f"))).toEqual([["shop.faq", "en"]])
  })

  test("the entry lifts the chunk map and loads a navigation's copy with its code", () => {
    const entry = readFileSync(join(outDir, manifest.entry.replace("/assets/", "")), "utf8")
    expect(entry).toContain(COPY_CHUNKS_GLOBAL)
    expect(entry).toContain(COPY_REALM)
    expect(entry).toContain(".prepare(")
  })
})

describe("the Vite pipeline", () => {
  test("splits the same tables, and the copy it moved is secret-scanned and written", async () => {
    const viteOut = join(root, "dist-vite", "assets")
    const built = await buildClientVite({
      root,
      routesDir: join(root, "routes"),
      outDir: viteOut,
      clientModule: join(root, "frontend/client-stub.ts"),
      publicDir: false,
    })
    const chunks = built.copyChunks ?? {}
    expect(Object.keys(chunks).sort()).toEqual(["ar", "en", "hi", "ta"])
    for (const url of Object.values(chunks)) {
      expect(existsSync(join(viteOut, url.replace("/assets/", "")))).toBe(true)
      expect(built.assets).toContain(url)
    }
    const code = readdirSync(viteOut)
      .filter((name) => name.endsWith(".js") && !name.startsWith("copy-"))
      .map((name) => readFileSync(join(viteOut, name), "utf8"))
      .join("\n")
    expect(scriptsFound(code)).toEqual([])
  }, 60_000)
})

describe("loadCopySplit", () => {
  const outside: string[] = []
  afterAll(() => {
    for (const dir of outside) rmSync(dir, { recursive: true, force: true })
  })
  // Outside the workspace, so nothing resolves but what the fixture installs.
  const app = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), "nifra-copy-split-"))
    outside.push(dir)
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true })
      writeFileSync(join(dir, file), text)
    }
    return dir
  }
  const DEFINES = 'import { defineCopy } from "@nifrajs/i18n/copy"\n'
  const i18nPackage = dirname(createRequire(import.meta.url).resolve("@nifrajs/i18n/package.json"))
  const typescriptPackage = dirname(
    createRequire(import.meta.url).resolve("typescript/package.json"),
  )

  test("an app without @nifrajs/i18n, or without a copy definition, has no split", async () => {
    expect(await loadCopySplit(app({ "src/i18n.ts": DEFINES }))).toBeUndefined()
    const plain = app({ "src/page.ts": "export const x = 1\n" })
    mkdirSync(join(plain, "node_modules/@nifrajs"), { recursive: true })
    symlinkSync(i18nPackage, join(plain, "node_modules/@nifrajs/i18n"), "dir")
    mkdirSync(join(plain, "locked"))
    chmodSync(join(plain, "locked"), 0o000)
    try {
      expect(await loadCopySplit(plain)).toBeUndefined()
    } finally {
      chmodSync(join(plain, "locked"), 0o755)
    }
  })

  test("an app whose TypeScript has no compiler API keeps its tables whole, with a warning", async () => {
    const warnings: string[] = []
    const warn = (message: string) => void warnings.push(message)
    const none = app({ "src/i18n.ts": DEFINES })
    mkdirSync(join(none, "node_modules/@nifrajs"), { recursive: true })
    symlinkSync(i18nPackage, join(none, "node_modules/@nifrajs/i18n"), "dir")
    expect(await loadCopySplit(none, { warn })).toBeUndefined()
    const seven = app({
      "src/i18n.ts": DEFINES,
      "node_modules/typescript/package.json": '{ "name": "typescript", "version": "7.0.0" }',
      "node_modules/typescript/index.js": 'module.exports = { version: "7.0.0" }\n',
    })
    mkdirSync(join(seven, "node_modules/@nifrajs"), { recursive: true })
    symlinkSync(i18nPackage, join(seven, "node_modules/@nifrajs/i18n"), "dir")
    expect(await loadCopySplit(seven, { warn })).toBeUndefined()
    expect(warnings).toHaveLength(2)
    for (const warning of warnings) expect(warning).toContain("TypeScript 7 ships none")
  })

  test("an @nifrajs/i18n older than the split keeps tables whole, with a warning", async () => {
    const warnings: string[] = []
    const old = app({
      "src/i18n.ts": DEFINES,
      "node_modules/@nifrajs/i18n/package.json":
        '{ "name": "@nifrajs/i18n", "type": "module", "exports": { "./extract": "./extract.js" } }',
      "node_modules/@nifrajs/i18n/extract.js": "export const nothing = 1\n",
    })
    symlinkSync(typescriptPackage, join(old, "node_modules/typescript"), "dir")
    expect(await loadCopySplit(old, { warn: (m) => void warnings.push(m) })).toBeUndefined()
    expect(warnings).toEqual([expect.stringContaining("predates the client split")])
  })

  test("rewrite leaves alone a module it cannot read as the build does", async () => {
    write(
      "extra/bare.ts",
      'import { copy } from "not-a-package"\nexport const X = copy({ en: "x" })\n',
    )
    const split = await loadCopySplit(root)
    if (split === undefined) throw new Error("the fixture defines copy tables")
    const index = join(root, "routes/index.tsx")
    expect(split.rewrite(index, "changed by another plugin")).toBeUndefined()
    expect(split.rewrite(join(root, "missing.ts"), "")).toBeUndefined()
    expect(split.rewrite(join(root, "node_modules/dep/index.ts"), "")).toBeUndefined()
    expect(split.rewrite(join(root, "styles.css"), "")).toBeUndefined()
    const bare = join(root, "extra/bare.ts")
    expect(split.rewrite(bare, readFileSync(bare, "utf8"))).toBeUndefined()
    expect(split.rewrite(index, readFileSync(index, "utf8"))).toContain("__nifraCopyRef(")
    expect(split.chunks("/static/").urls.hi).toStartWith("/static/copy-hi-")
  })
})

describe("the server side of a split build", () => {
  test("the server manifest bakes copyChunks, and a re-sync keeps it", () => {
    const routes = discoverRoutes(join(root, "routes"))
    const copyChunks = { en: "/assets/copy-en-1.js", hi: "/assets/copy-hi-2.js" }
    const source = generateServerManifest(routes, {
      resolve: (file) => `./routes/${file}`,
      clientEntry: "/assets/entry.js",
      copyChunks,
    })
    expect(source).toContain(`export const copyChunks = ${JSON.stringify(copyChunks)}`)
    expect(resyncServerManifestSource(source, routes, "./routes/")).toBe(source)
    const unsplit = generateServerManifest(routes, {
      resolve: (file) => `./routes/${file}`,
      clientEntry: "/assets/entry.js",
    })
    expect(unsplit).not.toContain("copyChunks")
  })

  test("the generated server entry passes copyChunks to createWebApp only for a split build", () => {
    const split = generateServerEntry({
      target: "bun",
      adapterImport: "./adapter",
      copyChunks: true,
    })
    expect(split).toContain("copyChunks, cssLoading")
    expect(split).toContain("  copyChunks,\n")
    expect(generateServerEntry({ target: "bun", adapterImport: "./adapter" })).not.toContain(
      "copyChunks",
    )
  })

  test("an unsplit client entry is unchanged", () => {
    const routes = discoverRoutes(join(root, "routes"))
    const options = { clientModule: "x", resolve: (file: string) => `./${file}` }
    const plain = generateClientEntry(routes, options)
    expect(plain).not.toContain(COPY_REALM)
    expect(plain).toContain("const loadModule = async (id) => {")
    expect(generateClientEntry(routes, { ...options, copyChunks: true })).toContain(
      "const loadModule = async (id, path) => {",
    )
  })

  test("a page hands the chunk map over and preloads the locales it renders in", async () => {
    const adapter: RenderAdapter = {
      hydrationHead: () => "",
      renderToStream: () => new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      renderToString: () => "<main></main>",
    }
    const realmKey = Symbol.for(COPY_REALM)
    const previous: unknown = Reflect.get(globalThis, realmKey)
    const asked: unknown[] = []
    Reflect.set(globalThis, realmKey, {
      pageLocales: (path: string, lang: string) => {
        asked.push([path, lang])
        return ["hi", "en"]
      },
    })
    try {
      const page = await renderPageResult({
        adapter,
        chain: [() => null],
        data: null,
        clientEntry: "/assets/entry.js",
        path: "/hi/today",
        copyChunks: {
          en: "/assets/copy-en.js",
          hi: "/assets/copy-hi.js",
          ta: "/assets/copy-ta.js",
        },
      })
      const html = await page.toResponse().text()
      expect(asked).toEqual([["/hi/today", "en"]])
      expect(html).toContain('<link rel="modulepreload" href="/assets/copy-hi.js">')
      expect(html).toContain('<link rel="modulepreload" href="/assets/copy-en.js">')
      expect(html).not.toContain('modulepreload" href="/assets/copy-ta.js"')
      expect(html).toContain(
        `"${COPY_CHUNKS_GLOBAL}":{"en":"/assets/copy-en.js","hi":"/assets/copy-hi.js","ta":"/assets/copy-ta.js"}`,
      )
    } finally {
      if (previous === undefined) Reflect.deleteProperty(globalThis, realmKey)
      else Reflect.set(globalThis, realmKey, previous)
    }
  })
})
