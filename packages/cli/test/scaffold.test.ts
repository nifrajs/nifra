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

  test("refuses a param constraint: a route file name cannot carry one", () => {
    expect(() => routePathToFile("/users/:id{[0-9]+}", "tsx")).toThrow(
      'a param constraint cannot be written in a route file name: ":id{[0-9]+}" in "/users/:id{[0-9]+}"',
    )
    expect(() => routePathToFile("/img/:kind{thumb|full}/edit", "tsx")).toThrow(
      /check the value in the route's loader/,
    )
    expect(() => scaffoldRoute("/users/:id{[0-9]+}", "react")).toThrow(/param constraint/)
  })

  test("rejects filesystem traversal and separator syntax", () => {
    expect(() => routePathToFile("/../src/escape", "tsx")).toThrow(/invalid route segment/)
    expect(() => routePathToFile("/a/../../src/escape", "tsx")).toThrow(/invalid route segment/)
    expect(() => routePathToFile("/a\\..\\src", "tsx")).toThrow(/invalid route segment/)
  })
})

describe("scaffoldRoute", () => {
  test("JSX frameworks get a ready-to-write route pair", () => {
    const r = scaffoldRoute("/users/:id", "react")
    expect(r.file).toBe("routes/users/[id].tsx")
    expect(r.content).toContain("export default function Page({ data }: Route.ComponentProps)")
    expect(r.content).toContain('import type { Route } from "./+types/[id]"')
    // The page carries no server code: the loader and its schema live in the backend half.
    expect(r.content).not.toContain("loader")
    expect(r.backend.file).toBe("routes/users/[id].backend.ts")
    expect(r.backend.content).toContain("export const loaderOutput = t.object(")
    expect(r.backend.content).toContain(
      "export async function loader({ params }: Route.LoaderArgs)",
    )
    expect(r.note).toContain("routes/users/[id].backend.ts")
  })

  test("an optional param is read as possibly absent", () => {
    expect(scaffoldRoute("/[[lang]]", "react").backend.content).toContain('params.lang ?? ""')
  })

  test("vue/svelte get paths, the backend half and the contract, no hallucinated SFC", () => {
    const r = scaffoldRoute("/about", "svelte")
    expect(r.file).toBe("routes/about.svelte")
    expect(r.content).toBeUndefined() // no guessed SFC body
    expect(r.backend.file).toBe("routes/about.backend.ts")
    expect(r.backend.content).toContain("export const loaderOutput")
    expect(r.note).toContain("nifra_example")
  })

  test("vanilla gets a zero-runtime stub carrying the golden island pattern", () => {
    const r = scaffoldRoute("/hotels", "vanilla")
    expect(r.file).toBe("routes/hotels.ts")
    expect(r.content).toContain('import { html } from "@nifrajs/web-vanilla"')
    // `hydrate` is a server-only export now: it belongs to the backend half, never the page.
    expect(r.content).not.toContain("export const hydrate")
    expect(r.backend.content).toContain("export const hydrate = false") // no hydration, ever
    expect(r.content).toContain("defineIsland") // the AI-safe interactivity path
    expect(r.content).toContain("return () =>") // cleanup pattern NF-C020 enforces
    expect(r.note).toContain("islands")
  })

  test("vanilla + variant stateful emits the golden nano pattern", () => {
    const r = scaffoldRoute("/todos", "vanilla", "stateful")
    expect(r.file).toBe("routes/todos.ts")
    expect(r.backend.content).toContain("export const hydrate = false") // still zero-runtime
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
    expect(out).toContain("**Files:** `routes/users/[id].tsx` + `routes/users/[id].backend.ts`")
    expect(out).toContain("```tsx")
    expect(out).toContain("```ts\n// routes/users/[id].backend.ts")
  })

  test("renders an actionable error for an invalid path", () => {
    expect(renderScaffold("/a/*x/b", "react")).toContain("Cannot scaffold")
  })
})

describe("writeScaffoldRoute", () => {
  test("writes a verified route pair and its route types, and refuses to overwrite either", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-scaffold-"))
    try {
      const first = await writeScaffoldRoute(dir, "/users/:id", "react")
      expect(first.written).toBe(true)
      expect(await readFile(join(dir, "routes/users/[id].tsx"), "utf8")).toContain(
        "export default function Page",
      )
      expect(await readFile(join(dir, "routes/users/[id].backend.ts"), "utf8")).toContain(
        "export const loaderOutput",
      )
      expect(
        await readFile(join(dir, ".nifra/types/routes/users/+types/[id].d.ts"), "utf8"),
      ).toContain("export namespace Route")
      const second = await writeScaffoldRoute(dir, "/users/:id", "react")
      expect(second.written).toBe(false)
      expect(second.reason).toContain("already exists")

      // An existing backend half alone also stops the write: nothing is half-written.
      await rm(join(dir, "routes/users/[id].tsx"))
      const third = await writeScaffoldRoute(dir, "/users/:id", "react")
      expect(third.reason).toBe("file already exists: routes/users/[id].backend.ts")
      expect(await readFile(join(dir, "routes/users/[id].tsx")).catch(() => null)).toBeNull()
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

  test("refuses to write a traversal path outside routes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-scaffold-"))
    try {
      await expect(writeScaffoldRoute(dir, "/../src/escape", "react")).rejects.toThrow(
        /invalid route segment/,
      )
      expect(await readFile(join(dir, "src/escape.tsx")).catch(() => null)).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
