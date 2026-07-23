import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { t } from "@nifrajs/schema"
import type { LoadedApp } from "../src/load.ts"
import { renderOpenApi } from "../src/openapi-tool.ts"

function loaded(backend: unknown): LoadedApp {
  return {
    cwd: "/tmp/nifra-openapi-app",
    routesDir: "/tmp/nifra-openapi-app/routes",
    outDir: "/tmp/nifra-openapi-app/dist",
    framework: { adapter: {}, clientModule: "@nifrajs/web-react/client" },
    resolvedPlugins: { vitePlugins: [], clientPlugins: [], serverPlugins: [] },
    backend,
  }
}

describe("renderOpenApi", () => {
  test("renders a backend app through @nifrajs/schema", () => {
    const app = server().get(
      "/users/:id",
      { query: t.object({ verbose: t.boolean() }), response: t.object({ id: t.string() }) },
      (c) => ({ id: c.params.id }),
    )
    const doc = JSON.parse(renderOpenApi(loaded(app), "json")) as {
      info: { title: string }
      paths: Record<
        string,
        { get?: { parameters?: unknown[]; responses: Record<string, unknown> } }
      >
    }
    expect(doc.info.title).toBe("nifra-openapi-app API")
    expect(doc.paths["/users/{id}"]?.get?.parameters).toContainEqual({
      name: "id",
      in: "path",
      required: true,
      schema: { type: "string" },
    })
    expect(doc.paths["/users/{id}"]?.get?.responses["200"]).toBeDefined()
  })

  test("frontend-only apps return a valid empty document", () => {
    const doc = JSON.parse(renderOpenApi(loaded(undefined), "json")) as { paths: unknown }
    expect(doc.paths).toEqual({})
  })

  test("yaml output is available without changing the source document", () => {
    expect(renderOpenApi(loaded(undefined), "yaml")).toContain('"openapi": "3.1.0"')
  })

  test("a `path` prefix narrows the document to operations under that prefix", () => {
    const app = server()
      .get("/api/orders/:id", { response: t.object({ id: t.string() }) }, (c) => ({
        id: c.params.id,
      }))
      .post("/api/orders", { body: t.object({ total: t.number() }) }, () => ({ ok: true }))
      .get("/health", () => ({ ok: true }))

    const doc = JSON.parse(renderOpenApi(loaded(app), "json", "/api/orders")) as {
      paths: Record<string, unknown>
    }
    // Both /api/orders operations survive (templated key included); /health is dropped.
    expect(Object.keys(doc.paths).sort()).toEqual(["/api/orders", "/api/orders/{id}"])
    expect(doc.paths["/health"]).toBeUndefined()
  })

  test("an empty/absent `path` prefix returns the whole document", () => {
    const app = server()
      .get("/api/orders", () => ({ ok: true }))
      .get("/health", () => ({ ok: true }))
    const all = JSON.parse(renderOpenApi(loaded(app), "json")) as { paths: Record<string, unknown> }
    const emptyPrefix = JSON.parse(renderOpenApi(loaded(app), "json", "")) as {
      paths: Record<string, unknown>
    }
    expect(Object.keys(all.paths).sort()).toEqual(["/api/orders", "/health"])
    expect(Object.keys(emptyPrefix.paths).sort()).toEqual(["/api/orders", "/health"])
  })
})
