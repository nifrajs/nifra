import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type Framework,
  frameworkFromClientModule,
  renderScaffold,
  routePathToFile,
  scaffoldRoute,
  writeScaffoldRoute,
} from "../src/scaffold.ts"

describe("frameworkFromClientModule", () => {
  test("derives the framework, defaults to react", () => {
    expect(frameworkFromClientModule("@nifrajs/web-vue/client")).toBe("vue")
    expect(frameworkFromClientModule("@nifrajs/web-svelte/client")).toBe("svelte")
    expect(frameworkFromClientModule("@nifrajs/web-vanilla/client")).toBe("vanilla")
    expect(frameworkFromClientModule(undefined)).toBe("react")
    expect(frameworkFromClientModule("something-else")).toBe("react")
  })
})

describe("routePathToFile", () => {
  test("applies the file convention (URL or file spelling)", () => {
    expect(routePathToFile("/", "tsx")).toBe("routes/index.tsx")
    expect(routePathToFile("/users/:id", "tsx")).toBe("routes/users/[id].tsx")
    expect(routePathToFile("users/[id]", "tsx")).toBe("routes/users/[id].tsx") // already file-spelled
    expect(routePathToFile("/blog/*slug", "vue")).toBe("routes/blog/[...slug].vue")
    expect(routePathToFile("/files/*", "tsx")).toBe("routes/files/[...rest].tsx")
  })

  test("rejects a catch-all that isn't last", () => {
    expect(() => routePathToFile("/a/*rest/b", "tsx")).toThrow(/catch-all must be the last/)
  })
})

describe("scaffoldRoute", () => {
  test("JSX frameworks get a ready-to-write stub", () => {
    const r = scaffoldRoute("/users/:id", "react")
    expect(r.file).toBe("routes/users/[id].tsx")
    expect(r.content).toContain("export default function Page")
    expect(r.content).toContain("never top-level-import server-only") // the gotcha, inline
    expect(r.note).toContain("loader")
  })

  test("vue/svelte/vanilla get path + contract, no hallucinated SFC", () => {
    const r = scaffoldRoute("/about", "svelte")
    expect(r.file).toBe("routes/about.svelte")
    expect(r.content).toBeUndefined() // no guessed SFC body
    expect(r.note).toContain("nifra_example")
  })
})

describe("renderScaffold", () => {
  test("renders file + stub for react", () => {
    const out = renderScaffold("/users/:id", "react" as Framework)
    expect(out).toContain("**File:** `routes/users/[id].tsx`")
    expect(out).toContain("```tsx")
  })

  test("renders an actionable error for an invalid path", () => {
    expect(renderScaffold("/a/*x/b", "react")).toContain("Cannot scaffold")
  })
})

describe("writeScaffoldRoute", () => {
  test("writes a verified JSX stub and refuses to overwrite it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-scaffold-"))
    try {
      const first = await writeScaffoldRoute(dir, "/users/:id", "react")
      expect(first.written).toBe(true)
      expect(await readFile(join(dir, "routes/users/[id].tsx"), "utf8")).toContain(
        "export default function Page",
      )
      const second = await writeScaffoldRoute(dir, "/users/:id", "react")
      expect(second.written).toBe(false)
      expect(second.reason).toContain("already exists")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("does not write frameworks without verified stubs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-scaffold-"))
    try {
      const result = await writeScaffoldRoute(dir, "/about", "svelte")
      expect(result.written).toBe(false)
      expect(result.reason).toContain("no verified")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
