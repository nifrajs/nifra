import { describe, expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import { prepareModules } from "../src/internal/module-preparation.ts"
import { createWebApp } from "../src/internal/web-app.ts"
import type { RouteModule } from "../src/manifest.ts"
import { buildManifest } from "../src/manifest.ts"
import { splitRouteHalves } from "./_route-halves.ts"

describe("production module preparation", () => {
  test("imports once while gates and loaders run afresh for every visitor", async () => {
    let imports = 0
    let gates = 0
    let loads = 0
    const modules = splitRouteHalves<RouteModule>({
      "_layout.tsx": {
        default: "layout",
        gate: true,
        loaderOutput: t.object({ allowed: t.boolean() }),
        loader: ({ request }) => {
          gates++
          if (request.headers.get("authorization") !== "allowed")
            throw new Response("", { status: 403 })
          return { allowed: true }
        },
      },
      "index.tsx": {
        default: "page",
        loaderOutput: t.object({ count: t.integer() }),
        loader: () => ({ count: ++loads }),
      },
    })
    const manifest = buildManifest(Object.keys(modules), (file) => async () => {
      imports++
      return modules[file]!
    })
    const app = createWebApp({
      manifest,
      cacheRouteModules: true,
      clientEntry: "/client.js",
      adapter: {
        hydrationHead: () => "",
        renderToStream: (_chain, props) =>
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(JSON.stringify(props.data)))
              controller.close()
            },
          }),
      },
    })
    const request = (allowed: boolean) =>
      new Request("http://nifra.test/", { headers: allowed ? { authorization: "allowed" } : {} })
    const first = await app.fetch(request(true))
    expect(await first.text()).toContain('"count":1')
    const imported = imports
    const second = await app.fetch(request(true))
    expect(await second.text()).toContain('"count":2')
    expect((await app.fetch(request(false))).status).toBe(403)
    expect(gates).toBe(3)
    expect(loads).toBe(2)
    expect(imports).toBe(imported)
  })

  test("shares concurrent imports, preserves their receiver, and returns the settled module", async () => {
    let imports = 0
    const entry = {
      module: { default: () => null } satisfies RouteModule,
      async load() {
        imports++
        return this.module
      },
    }
    const load = prepareModules(true)
    const first = load(entry)
    expect(load(entry)).toBe(first)
    expect(await first).toBe(entry.module)
    expect(load(entry)).toBe(entry.module)
    expect(imports).toBe(1)
  })

  test("failed imports are retryable", async () => {
    let attempts = 0
    const entry = {
      async load() {
        if (++attempts === 1) throw new Error("retry")
        return {}
      },
    }
    const load = prepareModules(true)
    await expect(load(entry)).rejects.toThrow("retry")
    expect(await load(entry)).toEqual({})
    expect(attempts).toBe(2)
  })

  test("development imports observe replacements", async () => {
    let module: RouteModule = { default: null, meta: { title: "first" } }
    const entry = { load: async () => module }
    const load = prepareModules(false)
    expect(await load(entry)).toBe(module)
    module = { default: null, meta: { title: "updated" } }
    expect(await load(entry)).toBe(module)
  })
})
