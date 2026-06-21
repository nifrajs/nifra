import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  collectCheckResult,
  scanFetchText,
  scanProject,
  scanResponseRoutes,
  scanServerManifestDrift,
  scanServerOnlyImports,
  scanStaticRouteText,
  scanUntypedClient,
  stripComments,
} from "../src/check.ts"

describe("scanFetchText — own-API fetch detection", () => {
  test("flags relative-URL fetch (string and template), with accurate line numbers", () => {
    const src = [
      "const a = 1",
      'const r = await fetch("/users")',
      "const t = await fetch(`/users/" + "$" + "{id}`)",
      "const s = await fetch('/api/x', { method: 'POST' })",
    ].join("\n")
    const found = scanFetchText("routes/x.tsx", src)
    expect(found.map((f) => f.line)).toEqual([2, 3, 4])
    expect(found[0]).toEqual({
      file: "routes/x.tsx",
      line: 2,
      snippet: 'const r = await fetch("/users")',
    })
  })

  test("does NOT flag external (absolute or protocol-relative) URLs", () => {
    expect(scanFetchText("a.ts", 'fetch("https://api.example.com/x")')).toHaveLength(0)
    expect(scanFetchText("a.ts", 'fetch("http://x")')).toHaveLength(0)
    expect(scanFetchText("a.ts", 'fetch("//cdn.example.com/x")')).toHaveLength(0)
  })

  test("does NOT flag method calls (.fetch), prefetch, or a variable argument", () => {
    expect(scanFetchText("a.ts", "client.fetch(`/users`)")).toHaveLength(0) // a method, not global fetch
    expect(scanFetchText("a.ts", 'app.fetch(new Request("/x"))')).toHaveLength(0)
    expect(scanFetchText("a.ts", 'prefetch("/x")')).toHaveLength(0)
    expect(scanFetchText("a.ts", "fetch(url)")).toHaveLength(0) // variable — undecidable, left alone
    expect(scanFetchText("a.ts", "fetch(`" + "$" + "{base}/x`)")).toHaveLength(0) // not relative
  })
})

describe("scanProject — walks source, skips deps/build/tests", () => {
  test("flags app source but ignores node_modules, dist, and test files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-check-"))
    await mkdir(join(dir, "routes"), { recursive: true })
    await mkdir(join(dir, "node_modules", "x"), { recursive: true })
    await writeFile(join(dir, "routes", "users.tsx"), 'export const f = () => fetch("/users")')
    await writeFile(join(dir, "client.ts"), 'fetch("https://external.example.com/ok")') // external → ok
    await writeFile(join(dir, "app.test.ts"), 'fetch("/exercised-in-a-test")') // test → ignored
    await writeFile(join(dir, "node_modules", "x", "dep.ts"), 'fetch("/dep")') // dep → ignored

    const found = await scanProject(dir)
    expect(found).toHaveLength(1)
    expect(found[0]?.file).toBe("routes/users.tsx")
    await rm(dir, { recursive: true, force: true })
  })
})

describe("scanStaticRouteText — conservative source-only route collection", () => {
  test("collects simple Nifra route registrations without executing backend code", () => {
    const src = [
      'import { server } from "@nifrajs/core"',
      "export const backend = server()",
      '  .get("/users", () => [])',
      "  .post('/users', { body: schema }, (c) => c.body)",
    ].join("\n")

    expect(scanStaticRouteText("backend.ts", src).map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /users",
      "POST /users",
    ])
  })

  test("does NOT collect route-like calls from non-Nifra source", () => {
    expect(scanStaticRouteText("router.ts", 'app.get("/users", handler)')).toEqual([])
    expect(scanStaticRouteText("backend.ts", 'app.get("/users", handler)')).toEqual([])
  })
})

describe("scanServerOnlyImports — server-only imports in route modules", () => {
  test("flags DB drivers, node:/bun: builtins, and the ./db module in a routes/ file", () => {
    const flag = (src: string) => scanServerOnlyImports("routes/notes.tsx", src)
    expect(flag('import { Database } from "bun:sqlite"')).toHaveLength(1)
    expect(flag('import postgres from "postgres"')).toHaveLength(1)
    expect(flag('import { drizzle } from "drizzle-orm/postgres-js"')).toHaveLength(1)
    expect(flag('import { readFileSync } from "node:fs"')).toHaveLength(1)
    expect(flag('import { db, notes } from "../db"')).toHaveLength(1)
    expect(flag('import { db } from "../../db.ts"')).toHaveLength(1)
  })

  test("does NOT flag type-only imports, dynamic imports, or normal client deps", () => {
    const flag = (src: string) => scanServerOnlyImports("routes/notes.tsx", src)
    expect(flag('import type { Note } from "../db"')).toHaveLength(0) // erased at build
    expect(flag('const { db } = await import("../db")')).toHaveLength(0) // lazy, server-side only
    expect(flag('import { useState } from "react"')).toHaveLength(0)
    expect(flag('import { client } from "@nifrajs/client"')).toHaveLength(0)
  })

  test("only applies to routes/ files (server modules may import server-only code freely)", () => {
    const src = 'import { Database } from "bun:sqlite"'
    expect(scanServerOnlyImports("backend.ts", src)).toHaveLength(0)
    expect(scanServerOnlyImports("db/index.ts", src)).toHaveLength(0)
    expect(scanServerOnlyImports("routes/x.tsx", src)).toHaveLength(1)
  })
})

describe("collectCheckResult — structured result for --json / the MCP tool", () => {
  test("reports both lint rules as diagnostics; ok=false; typecheck skipped without a tsconfig", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-check-"))
    await mkdir(join(dir, "routes"), { recursive: true })
    await writeFile(
      join(dir, "routes", "notes.tsx"),
      ['import { db } from "../db"', 'export const f = () => fetch("/notes")'].join("\n"),
    )
    const result = await collectCheckResult(dir)
    expect(result.ok).toBe(false)
    expect(result.typecheck).toBe("skipped")
    expect(result.diagnostics.map((d) => d.rule).sort()).toEqual([
      "server-only-import",
      "typed-client",
    ])
    expect(result.diagnostics.every((d) => d.file === "routes/notes.tsx")).toBe(true)
    const fetchDiag = result.diagnostics.find((d) => d.rule === "typed-client")
    expect(fetchDiag?.suggestion?.kind).toBe("manual")
    expect(fetchDiag?.suggestion?.steps?.join("\n")).toContain("nifra_routes")
    const importDiag = result.diagnostics.find((d) => d.rule === "server-only-import")
    expect(importDiag?.suggestion?.title).toContain("server-only")
    await rm(dir, { recursive: true, force: true })
  })

  test("includes an exact typed-client rewrite for a simple matched own-API GET fetch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-check-"))
    await mkdir(join(dir, "src"), { recursive: true })
    await writeFile(
      join(dir, "backend.ts"),
      [
        'import { server } from "@nifrajs/core"',
        "export const backend = server()",
        '  .get("/users", () => [])',
      ].join("\n"),
    )
    await writeFile(join(dir, "src", "users.ts"), 'const res = await fetch("/users")\n')

    const result = await collectCheckResult(dir, { lintsOnly: true })
    const diagnostic = result.diagnostics.find((d) => d.rule === "typed-client")
    expect(diagnostic?.suggestion?.kind).toBe("edit")
    expect(diagnostic?.suggestion?.diff).toContain('-const res = await fetch("/users")')
    expect(diagnostic?.suggestion?.diff).toContain("+const res = await api.users.get()")
    expect(diagnostic?.suggestion?.steps?.join("\n")).toContain("Matched GET /users")

    await rm(dir, { recursive: true, force: true })
  })

  test("keeps manual guidance for own-API fetches with ambiguous request options", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-check-"))
    await mkdir(join(dir, "src"), { recursive: true })
    await writeFile(
      join(dir, "backend.ts"),
      [
        'import { server } from "@nifrajs/core"',
        "export const backend = server()",
        '  .get("/users", () => [])',
      ].join("\n"),
    )
    await writeFile(
      join(dir, "src", "users.ts"),
      'const res = await fetch("/users", { headers: authHeaders })\n',
    )

    const result = await collectCheckResult(dir, { lintsOnly: true })
    const diagnostic = result.diagnostics.find((d) => d.rule === "typed-client")
    expect(diagnostic?.suggestion?.kind).toBe("manual")
    expect(diagnostic?.suggestion?.diff).toBeUndefined()

    await rm(dir, { recursive: true, force: true })
  })
})

describe("scanResponseRoutes (feedback 2026-06: raw Response collapses typed client to data: never)", () => {
  const backend = (body: string) =>
    `import { server } from "@nifrajs/core"\nconst app = server()${body}`

  test("flags handlers returning a raw Response (arrow and block, new Response and Response.json)", () => {
    const src = backend(
      [
        '.get("/a", () => new Response("x"))',
        '.get("/b", () => Response.json({ ok: true }))',
        '.get("/c", (c) => {\n  return new Response("y")\n})',
        '.post("/d", (c) => {\n  return Response.json({ id: 1 })\n})',
      ].join("\n"),
    )
    expect(scanResponseRoutes("backend.ts", src)).toHaveLength(4)
  })

  test("does NOT flag plain-object returns, or Response usage in a non-server file", () => {
    expect(
      scanResponseRoutes("backend.ts", backend('.get("/a", () => ({ ok: true }))')),
    ).toHaveLength(0)
    // No `server(` call → not a backend route module; a Response here is unrelated to the typed client.
    expect(
      scanResponseRoutes("util.ts", 'export const wrap = () => new Response("x")'),
    ).toHaveLength(0)
  })

  test("is advisory in collectCheckResult — surfaced as a warning, does NOT fail the gate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-check-"))
    await writeFile(
      join(dir, "backend.ts"),
      backend('.get("/a", () => Response.json({ ok: true }))'),
    )
    const result = await collectCheckResult(dir)
    const warns = result.diagnostics.filter((d) => d.rule === "response-route")
    expect(warns).toHaveLength(1)
    expect(warns[0]?.severity).toBe("warning")
    // The only finding is advisory → the gate still passes.
    expect(result.ok).toBe(true)
    await rm(dir, { recursive: true, force: true })
  })

  test("does NOT flag a commented-out or doc-example Response (comments are stripped)", () => {
    const src = backend(
      [
        "  // legacy: .get('/x', () => new Response('x'))", // commented out → ignored
        '  .get("/doc", () => ({ note: `e.g. return Response.json(x)` }))', // in a template → ignored
        '  .get("/real", () => new Response("y"))', // the only real one → flagged
      ].join("\n"),
    )
    const found = scanResponseRoutes("backend.ts", src)
    expect(found).toHaveLength(1)
    expect(found[0]?.snippet).toContain('"/real"')
  })
})

describe("stripComments — blank comments + template literals, keep strings + positions", () => {
  test("blanks line/block comments and backtick contents, preserves newlines + quoted strings", () => {
    const src = [
      'import "react" // comment with "fake"',
      '/* block\n with import "x" */',
      'const t = `import "in-template"`',
      'const s = "keep//me"',
    ].join("\n")
    const stripped = stripComments(src)
    expect(stripped.split("\n")).toHaveLength(src.split("\n").length) // positions unchanged
    expect(stripped).toContain('import "react"') // real import survives
    expect(stripped).toContain('"keep//me"') // `//` inside a string is not a comment
    expect(stripped).not.toContain("fake") // line-comment text gone
    expect(stripped).not.toContain('import "x"') // block-comment text gone
    expect(stripped).not.toContain("in-template") // backtick contents gone
  })
})

describe("scanUntypedClient (audit 2026-06: missing <typeof app> bypasses anti-drift)", () => {
  test('flags client("…") url-first without a type argument', () => {
    const src = 'const api = client("https://api.example.com")\n'
    const found = scanUntypedClient("src/api.ts", src)
    expect(found.length).toBe(1)
    expect(found[0]?.line).toBe(1)
  })

  test("collectCheckResult includes an exact one-line diff for client type argument fixes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-check-client-"))
    await mkdir(join(dir, "src"), { recursive: true })
    await writeFile(join(dir, "src", "api.ts"), 'const api = client("https://api.example.com")\n')

    const result = await collectCheckResult(dir, { lintsOnly: true })
    const diagnostic = result.diagnostics.find((d) => d.rule === "untyped-client")
    expect(diagnostic?.suggestion?.kind).toBe("edit")
    expect(diagnostic?.suggestion?.diff).toContain('-const api = client("https://api.example.com")')
    expect(diagnostic?.suggestion?.diff).toContain(
      '+const api = client<typeof app>("https://api.example.com")',
    )

    await rm(dir, { recursive: true, force: true })
  })

  test("does NOT flag the typed or contract forms, or unrelated members", () => {
    const src = [
      'const a = client<typeof app>("https://api.example.com")',
      "const b = client(contract, url)",
      'const c = thing.client("x")',
      'const d = myclient("x")',
    ].join("\n")
    expect(scanUntypedClient("src/api.ts", src)).toEqual([])
  })
})

describe("collectCheckResult — doctor integration for undeclared dependencies", () => {
  test("flags undeclared packages and fails collectCheckResult", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-check-doctor-"))
    await mkdir(join(dir, "routes"), { recursive: true })

    const pkg = {
      name: "test-app",
      dependencies: {
        "@nifrajs/core": "workspace:*",
      },
    }
    await writeFile(join(dir, "package.json"), JSON.stringify(pkg, null, 2))
    await writeFile(join(dir, "routes", "index.tsx"), 'import "react"\nimport "@nifrajs/core"\n')

    const result = await collectCheckResult(dir)
    expect(result.ok).toBe(false)
    const undeclared = result.diagnostics.filter((d) => d.rule === "undeclared-dependency")
    expect(undeclared).toHaveLength(1)
    expect(undeclared[0]?.file).toBe("routes/index.tsx")
    expect(undeclared[0]?.message).toContain("react")
    expect(undeclared[0]?.suggestion).toEqual({
      kind: "command",
      title: "Declare react in package.json",
      command: ["bun", "add", "react"],
    })

    await rm(dir, { recursive: true, force: true })
  })
})

// #7 — server-manifest drift. A committed, generated `server-manifest.ts` bakes the route list for a
// disk-less worker; if `routes/` changes but the manifest isn't regenerated, the worker serves a stale
// route table (silent edge break). The check diffs the committed manifest's route imports against the
// live routes/ tree.

/** A generated server-manifest (eager shape) importing the given route files under `./routes/`, with
 * the GENERATED marker the scanner keys on. */
const manifestSource = (routeFiles: readonly string[]): string =>
  [
    "// GENERATED by @nifrajs/web generateServerManifest — route manifest for the disk-less edge",
    'import { buildManifest } from "@nifrajs/web"',
    ...routeFiles.map((f, i) => `import * as m${i} from "./routes/${f}"`),
    "const modules = { }",
    'export const clientEntry = "/assets/_nifra-entry-abc123.js"',
    "export const manifest = buildManifest(Object.keys(modules), (file) => () => Promise.resolve(modules[file]))",
  ].join("\n")

/** Lay down a temp app with a server-manifest + the given on-disk route files. */
async function manifestApp(
  manifestFiles: readonly string[],
  diskFiles: readonly string[],
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nifra-manifest-"))
  await mkdir(join(dir, "routes"), { recursive: true })
  for (const f of diskFiles) {
    await writeFile(join(dir, "routes", f), "export default function P() { return null }\n")
  }
  await writeFile(join(dir, "server-manifest.ts"), manifestSource(manifestFiles))
  return dir
}

describe("scanServerManifestDrift", () => {
  test("a manifest that matches routes/ → no drift", async () => {
    const dir = await manifestApp(["index.tsx", "about.tsx"], ["index.tsx", "about.tsx"])
    const findings = await scanServerManifestDrift(dir)
    expect(findings).toEqual([])
    await rm(dir, { recursive: true, force: true })
  })

  test("a new route on disk not in the manifest → reported as missing", async () => {
    const dir = await manifestApp(["index.tsx"], ["index.tsx", "blog.tsx"])
    const findings = await scanServerManifestDrift(dir)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.file).toBe("server-manifest.ts")
    expect(findings[0]?.missing).toEqual(["blog.tsx"])
    expect(findings[0]?.extra).toEqual([])
    await rm(dir, { recursive: true, force: true })
  })

  test("a deleted route still imported by the manifest → reported as extra", async () => {
    const dir = await manifestApp(["index.tsx", "gone.tsx"], ["index.tsx"])
    const findings = await scanServerManifestDrift(dir)
    expect(findings[0]?.extra).toEqual(["gone.tsx"])
    expect(findings[0]?.missing).toEqual([])
    await rm(dir, { recursive: true, force: true })
  })

  test("a non-generated server-manifest.ts (no marker) is ignored", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-manifest-"))
    await mkdir(join(dir, "routes"), { recursive: true })
    await writeFile(join(dir, "routes", "index.tsx"), "export default () => null\n")
    // A user file that merely shares the name but isn't a generated manifest.
    await writeFile(join(dir, "server-manifest.ts"), "export const manifest = {}\n")
    expect(await scanServerManifestDrift(dir)).toEqual([])
    await rm(dir, { recursive: true, force: true })
  })
})

describe("collectCheckResult — server-manifest drift rule", () => {
  test("a drifted manifest fails the gate with the named server-manifest-drift error", async () => {
    const dir = await manifestApp(["index.tsx"], ["index.tsx", "new.tsx"])
    const result = await collectCheckResult(dir, { lintsOnly: true })
    expect(result.ok).toBe(false)
    const diag = result.diagnostics.find((d) => d.rule === "server-manifest-drift")
    expect(diag).toBeDefined()
    expect(diag?.severity).toBe("error")
    expect(diag?.message).toContain("new.tsx")
    expect(diag?.message).toContain("drifted from routes/")
    expect(diag?.suggestion?.title).toContain("Regenerate")
    await rm(dir, { recursive: true, force: true })
  })

  test("an in-sync manifest adds no drift diagnostic", async () => {
    const dir = await manifestApp(["index.tsx"], ["index.tsx"])
    const result = await collectCheckResult(dir, { lintsOnly: true })
    expect(result.diagnostics.find((d) => d.rule === "server-manifest-drift")).toBeUndefined()
    await rm(dir, { recursive: true, force: true })
  })
})
