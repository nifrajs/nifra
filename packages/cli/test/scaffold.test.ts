import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises"
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

  test("vue/svelte get path + contract, no hallucinated SFC", () => {
    const r = scaffoldRoute("/about", "svelte")
    expect(r.file).toBe("routes/about.svelte")
    expect(r.content).toBeUndefined() // no guessed SFC body
    expect(r.note).toContain("nifra_example")
  })

  test("vanilla gets a zero-runtime stub carrying the golden island pattern", () => {
    const r = scaffoldRoute("/hotels", "vanilla")
    expect(r.file).toBe("routes/hotels.ts")
    expect(r.content).toContain('import { html } from "@nifrajs/web-vanilla"')
    expect(r.content).toContain("export const hydrate = false") // no hydration, ever
    expect(r.content).toContain("defineIsland") // the AI-safe interactivity path
    expect(r.content).toContain("return () =>") // cleanup pattern NF-C020 enforces
    expect(r.note).toContain("islands")
  })

  test("vanilla + variant stateful emits the golden nano pattern", () => {
    const r = scaffoldRoute("/todos", "vanilla", "stateful")
    expect(r.file).toBe("routes/todos.ts")
    expect(r.content).toContain("export const hydrate = false") // still zero-runtime, no hydration
    expect(r.content).toContain(
      'import { signal, computed, bind, bindList } from "@nifrajs/web/nano"',
    )
    expect(r.content).toContain("[items])") // computed declares its deps (NF-C023 shape)
    expect(r.content).toContain("key: (t) => t.id") // stable key, not index (NF-C022 shape)
    expect(r.content).toContain("cleanups.push(bind") // disposers collected (NF-C021 shape)
    expect(r.note).toContain("nano")
  })

  test("variant stateful is a no-op flavour on JSX frameworks", () => {
    const plain = scaffoldRoute("/users/:id", "react")
    const stateful = scaffoldRoute("/users/:id", "react", "stateful")
    expect(stateful.content).toBe(plain.content) // nano is vanilla-only; JSX falls back to its own stub
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

  test("writes the nano stub for vanilla + variant stateful", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-scaffold-"))
    try {
      const r = await writeScaffoldRoute(dir, "/todos", "vanilla", "stateful")
      expect(r.written).toBe(true)
      expect(await readFile(join(dir, "routes/todos.ts"), "utf8")).toContain('@nifrajs/web/nano"')
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

  test("refuses to write through a route-directory symlink", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-scaffold-"))
    const outside = await mkdtemp(join(tmpdir(), "nifra-scaffold-outside-"))
    try {
      await symlink(outside, join(dir, "routes"))
      await expect(writeScaffoldRoute(dir, "/escape", "react")).rejects.toThrow(
        /symlinked directory/,
      )
      expect(await readFile(join(outside, "escape.tsx")).catch(() => null)).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})
