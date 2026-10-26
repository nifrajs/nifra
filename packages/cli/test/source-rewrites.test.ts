import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import ts from "typescript"
import { getSourceRewrite } from "../src/source-rewrites.ts"
import { chainRecipes, computeUpgrade, runUpgrade } from "../src/upgrade.ts"
import { createFixtureRoot, removeFixtureRoot } from "./fixture-root.ts"

const FIXTURES = createFixtureRoot("tmp-nifra-source-rewrites")

afterEach(() => {
  removeFixtureRoot(FIXTURES)
})

const rewrite = (text: string, file = "server.ts") => {
  const serveStatic = getSourceRewrite("serve-static")
  if (serveStatic === undefined) throw new Error("the serve-static rewrite is registered")
  return serveStatic.rewrite(ts, file, text)
}

describe("serve-static rewrite", () => {
  test("servePublicDir on Bun becomes core's serveStatic with the options that keep its answers", () => {
    const result = rewrite(`import { createWebApp, servePublicDir } from "@nifrajs/web"

const assets = servePublicDir({ dir: "/srv/public" })
`)
    expect(result.text).toBe(`import { createWebApp } from "@nifrajs/web"
import { ONE_DAY, serveStatic } from "@nifrajs/core/serve-static"

const assets = serveStatic({ dir: "/srv/public", prefix: "/", fallthrough: true, hashedFiles: (path) => path.startsWith("/assets/"), cacheControl: ONE_DAY })
`)
    expect(result.count).toBe(1)
    expect(result.manual).toEqual([])
  })

  test("each option maps: hashedPrefix, hashedFiles, cache.assets, files, shorthand, and a multi-line literal", () => {
    const result = rewrite(`import { servePublicDir } from "@nifrajs/web"

const dir = "/srv"
export const a = servePublicDir({ dir, hashedPrefix: "/static/", files: listed })
export const b = servePublicDir({
  dir: dir,
  hashedFiles: new Set(build.assets),
  cache: { hashed: "public, max-age=31536000, immutable", assets: "no-cache" },
})
`)
    expect(result.text).toBe(`import { ONE_DAY, serveStatic } from "@nifrajs/core/serve-static"

const dir = "/srv"
export const a = serveStatic({ dir, prefix: "/", fallthrough: true, hashedFiles: (path) => path.startsWith("/static/"), cacheControl: ONE_DAY, files: listed })
export const b = serveStatic({
  dir: dir,
  prefix: "/",
  fallthrough: true,
  hashedFiles: new Set(build.assets),
  cacheControl: "no-cache",
})
`)
    expect(result.count).toBe(2)
    expect(
      rewrite(`import { servePublicDir } from "@nifrajs/web"
export const c = servePublicDir({ dir, hashedPrefix })
`).text,
    ).toBe(`import { ONE_DAY, serveStatic } from "@nifrajs/core/serve-static"
export const c = serveStatic({ dir, prefix: "/", fallthrough: true, hashedFiles: (path) => path.startsWith(hashedPrefix), cacheControl: ONE_DAY })
`)
  })

  test("a file that serves on Node or Deno gets that adapter's serveStatic", () => {
    const node = rewrite(`import { serve } from "@nifrajs/node"
import { servePublicDir } from "@nifrajs/web"

const files = servePublicDir({ dir: "/srv" })
await serve(app, { port: 3000, static: (request) => files(request) })
`)
    expect(node.text).toBe(`import { serve, serveStatic } from "@nifrajs/node"

const files = serveStatic({ dir: "/srv", prefix: "/", fallthrough: true, hashedFiles: (path) => path.startsWith("/assets/"), cacheControl: "public, max-age=86400" })
await serve(app, { port: 3000, static: (request) => files(request) })
`)
    const deno = rewrite(`import { serve } from '@nifrajs/deno'
import { createWebApp, servePublicDir } from '@nifrajs/web'

await serve(app, { port: 3000, static: servePublicDir({ dir: "/srv" }) })
`)
    expect(deno.text).toBe(`import { serve, serveStatic } from '@nifrajs/deno'
import { createWebApp } from '@nifrajs/web'

await serve(app, { port: 3000, static: serveStatic({ dir: "/srv", prefix: "/", fallthrough: true, hashedFiles: (path) => path.startsWith("/assets/"), cacheControl: "public, max-age=86400" }) })
`)
  })

  test("Node's mount objects are wrapped in serveStatic, and signals becomes gracefulSignals", () => {
    const result = rewrite(`import { serve as serveNode } from "@nifrajs/node"

await serveNode(app, { port: 3000, signals: { drainMs: 8_000 }, static: [{ dir: "/a" }, { dir: "/b", prefix: "/" }] })
await serveNode(app, { port: 3001, signals, static: { dir: "/c" } })
`)
    expect(result.text).toBe(`import { serve as serveNode, serveStatic } from "@nifrajs/node"

await serveNode(app, { port: 3000, gracefulSignals: { drainMs: 8_000 }, static: serveStatic([{ dir: "/a" }, { dir: "/b", prefix: "/" }]) })
await serveNode(app, { port: 3001, gracefulSignals: signals, static: serveStatic({ dir: "/c" }) })
`)
    expect(result.count).toBe(4)
    expect(
      rewrite(`import { serve } from "@nifrajs/deno"
await serve(app, { port: 3000, signals: true })
`).text,
    ).toBe(`import { serve } from "@nifrajs/deno"
await serve(app, { port: 3000, gracefulSignals: true })
`)
  })

  test("a call already passing a function, or no static at all, is left as it is", () => {
    const source = `import { serve, serveStatic } from "@nifrajs/node"

await serve(app, { port: 3000, gracefulSignals: true, static: serveStatic({ dir: "/a" }) })
await serve(app, { port: 3001, static: (request) => undefined })
`
    expect(rewrite(source)).toEqual({ text: source, count: 0, manual: [] })
  })

  test("a shape it cannot map whole is listed by line and left alone", () => {
    const source = `import { serve } from "@nifrajs/node"
import { type ServePublicDirOptions, servePublicDir } from "@nifrajs/web"

const options: ServePublicDirOptions = { dir: "/srv" }
const a = servePublicDir(options)
const b = servePublicDir({ dir: "/srv", cache: { hashed: "public, max-age=60" } })
const c = servePublicDir({ ...options })
const pick = servePublicDir
await serve(app, { port: 3000, static: mounts })
await serve(app, settings)
`
    const result = rewrite(source)
    expect(result.manual.map(({ line }) => line)).toEqual([2, 5, 6, 7, 8, 9, 10])
    expect(result.manual[0]?.reason).toContain("ServePublicDirOptions is removed")
    expect(result.manual[2]?.reason).toContain("`cache.hashed` has no counterpart")
    expect(result.manual[5]?.reason).toContain("`static` takes a function now")
    // Nothing it could not rewrite loses its import.
    expect(result.count).toBe(0)
    expect(result.text).toBe(source)
  })

  test("servePublicDir reached other than by a static import is listed", () => {
    const result = rewrite(`const { servePublicDir } = await import("@nifrajs/web")
export const files = servePublicDir({ dir: "/srv" })
`)
    expect(result.manual.map(({ line }) => line)).toEqual([1, 2])
    expect(result.count).toBe(0)
  })

  test("the HashedFiles type moves with its alias, and an emptied web import is removed", () => {
    const result = rewrite(`import type { RenderAdapter } from "@nifrajs/web"
import { type HashedFiles as Hashed, servePublicDir } from "@nifrajs/web"

const hashed: Hashed = [/x/]
export const a = servePublicDir({ dir: "/srv", hashedFiles: hashed })
`)
    expect(result.text).toBe(`import type { RenderAdapter } from "@nifrajs/web"
import { type HashedFiles as Hashed, ONE_DAY, serveStatic } from "@nifrajs/core/serve-static"

const hashed: Hashed = [/x/]
export const a = serveStatic({ dir: "/srv", prefix: "/", fallthrough: true, hashedFiles: hashed, cacheControl: ONE_DAY })
`)
  })

  test("files with nothing to rewrite are never parsed", () => {
    const serveStatic = getSourceRewrite("serve-static")
    expect(
      serveStatic?.mentions('import { serve } from "@nifrajs/node"\nserve(app, { port })'),
    ).toBe(false)
    expect(
      serveStatic?.mentions('import { serve } from "@nifrajs/node"\nserve(app, { signals })'),
    ).toBe(true)
    expect(serveStatic?.mentions("servePublicDir")).toBe(true)
  })
})

describe("an upgrade with a source rewrite", () => {
  const project = async (name: string): Promise<string> => {
    const root = join(FIXTURES, name)
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "app", dependencies: { "@nifrajs/web": "^5.8.0" } }, null, 2),
    )
    await writeFile(
      join(root, "src/server.ts"),
      'import { servePublicDir } from "@nifrajs/web"\nexport const files = servePublicDir({ dir: "/srv" })\n',
    )
    return root
  }

  test("rewrites the source, then adds the package its new import needs", async () => {
    const root = await project("with-ts")
    const plan = computeUpgrade(root, chainRecipes("5.9.0", "5.8.0"), true, false, false, [], ts)
    expect(plan.sourceRewrites).toEqual([
      { file: "src/server.ts", rewrite: "serve-static", count: 1 },
    ])
    expect(plan.rewritesNeedTypeScript).toEqual([])
    expect(await readFile(join(root, "src/server.ts"), "utf8")).toContain(
      'import { ONE_DAY, serveStatic } from "@nifrajs/core/serve-static"',
    )
    expect(plan.dependencyAdds.map(({ name }) => name)).toEqual(["@nifrajs/core"])
  })

  test("without TypeScript it refuses before writing anything", async () => {
    const root = await project("without-ts")
    const before = await readFile(join(root, "package.json"), "utf8")
    const plan = computeUpgrade(root, chainRecipes("5.9.0", "5.8.0"), false)
    expect(plan.rewritesNeedTypeScript).toEqual(["src/server.ts"])
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      expect(
        await runUpgrade(root, {
          version: "5.9.0",
          cliVersion: "5.9.0",
          write: true,
          verify: false,
          loadTypeScript: async () => undefined,
        }),
      ).toBe(false)
      expect(String(errors.mock.calls[0]?.[0])).toContain("bun add -d typescript")
    } finally {
      errors.mockRestore()
    }
    expect(await readFile(join(root, "package.json"), "utf8")).toBe(before)
  })
})
