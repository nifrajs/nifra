import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverRoutes } from "../src/fs.ts"

const withRoutes = (files: Record<string, string>, fn: (dir: string) => void | Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), "nifra-loader-"))
  try {
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(join(dir, name, ".."), { recursive: true })
      writeFileSync(join(dir, name), body)
    }
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test("an injected loader resolves route modules instead of a bare import", async () => {
  // This is what lets a pipeline own SSR: a bare `import()` always resolves through the RUNTIME, so
  // the Vite dev server served the client while Bun resolved the server — two resolvers, one process.
  await withRoutes({ "index.tsx": "export default 1" }, async (dir) => {
    const seen: string[] = []
    const manifest = discoverRoutes(dir, {
      load: async (path) => {
        seen.push(path)
        return { default: "from-injected-loader" }
      },
    })
    const mod = await (manifest.routes[0] as { load: () => Promise<{ default: unknown }> }).load()
    expect(mod.default).toBe("from-injected-loader")
    expect(seen).toEqual([join(dir, "index.tsx")])
  })
})

test("no importQuery is appended when a loader is injected", async () => {
  // An injected loader owns its own invalidation — Vite re-evaluates on change. Appending a
  // cache-buster would mint a new module id per request and defeat that.
  await withRoutes({ "index.tsx": "export default 1" }, async (dir) => {
    const seen: string[] = []
    const manifest = discoverRoutes(dir, {
      importQuery: "v=123",
      load: async (path) => {
        seen.push(path)
        return { default: 1 }
      },
    })
    await (manifest.routes[0] as { load: () => Promise<unknown> }).load()
    expect(seen[0]).not.toContain("?")
    expect(seen[0]).not.toContain("v=123")
  })
})

test("without a loader the manifest is unchanged", async () => {
  // The Bun pipeline keeps the bare dynamic import, which is correct for it.
  await withRoutes({ "index.tsx": "export default 1" }, (dir) => {
    const manifest = discoverRoutes(dir)
    expect(manifest.routes).toHaveLength(1)
    expect(manifest.routes[0]?.pattern).toBe("/")
    expect(typeof manifest.routes[0]?.load).toBe("function")
  })
})

test("every route in the chain goes through the injected loader", async () => {
  await withRoutes(
    { "index.tsx": "export default 1", "posts/[id].tsx": "export default 2" },
    async (dir) => {
      const seen: string[] = []
      const manifest = discoverRoutes(dir, {
        load: async (p) => {
          seen.push(p.slice(dir.length + 1))
          return { default: 1 }
        },
      })
      for (const r of manifest.routes) await r.load()
      expect(seen.sort()).toEqual(["index.tsx", "posts/[id].tsx"])
    },
  )
})
