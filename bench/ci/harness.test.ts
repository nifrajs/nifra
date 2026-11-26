import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { buildNodeBundle } from "../bundle.ts"
import { FILES, rewriteForPublished } from "../http-realworld/published-files.ts"

const APP_DIR = join(import.meta.dir, "..", "http-realworld")

describe("published benchmark tree", () => {
  test("stages every sibling its files import, with no workspace path left", async () => {
    const staged: ReadonlySet<string> = new Set(FILES)
    for (const file of FILES) {
      const source = rewriteForPublished(await Bun.file(join(APP_DIR, file)).text())
      expect(source).not.toContain("../../packages/")
      for (const { path } of new Bun.Transpiler({ loader: "ts" }).scanImports(source)) {
        if (!path.startsWith("./") || path.startsWith("./node_modules/")) continue
        expect(staged, `${file} imports ${path}`).toContain(path.slice(2))
      }
    }
  })
})

describe("buildNodeBundle", () => {
  const saved = Bun.env.BENCH_SKIP_BUILD
  afterEach(() => {
    if (saved === undefined) delete Bun.env.BENCH_SKIP_BUILD
    else Bun.env.BENCH_SKIP_BUILD = saved
  })

  test("builds unless a rerun says the first run already did", async () => {
    const build = buildNodeBundle(import.meta.dir, "no-such-entry.ts")
    delete Bun.env.BENCH_SKIP_BUILD
    await expect(build()).rejects.toThrow()
    Bun.env.BENCH_SKIP_BUILD = "1"
    await expect(build()).resolves.toBeUndefined()
  })
})
