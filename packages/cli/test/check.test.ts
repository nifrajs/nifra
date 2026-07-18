import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  collectCheckResult,
  type ModuleReader,
  type ModuleResolver,
  parseStaticImports,
  resolveServerOnlyChains,
  scanFetchText,
  scanProject,
  scanResponseRoutes,
  scanServerManifestDrift,
  scanServerOnlyImports,
  scanStaticRouteText,
  scanUntypedClient,
  stripComments,
  walkServerOnlyChain,
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

  test("does NOT flag calls shown inside comments or documentation strings", () => {
    const src = [
      '// fetch("/comment")',
      "const docs = 'use fetch(\"/users\") here'",
      'const template = `fetch("/template")`',
    ].join("\n")
    expect(scanFetchText("a.ts", src)).toEqual([])
  })

  test("does NOT flag Nifra page-data fetches with a literal x-nifra-data header", () => {
    const src = [
      'const first = fetch("/", { headers: { "x-nifra-data": "1" } })',
      "const second = fetch('/todos', {",
      '  "headers": {',
      "    'x-nifra-data': '1',",
      "  },",
      "})",
      'const ownApi = fetch("/api/users", {',
      '  headers: { "authorization": token },',
      "})",
    ].join("\n")

    expect(scanFetchText("routes/todos.tsx", src)).toEqual([
      {
        file: "routes/todos.tsx",
        line: 7,
        snippet: 'const ownApi = fetch("/api/users", {',
      },
    ])
  })

  test("keeps flagging same-origin fetches without a literal x-nifra-data header property", () => {
    const calls = [
      'fetch("/api/users", { headers: dataHeaders })',
      'fetch("/api/users", { headers: { "x-other": "1" } })',
      'fetch("/api/users", { body: JSON.stringify({ "x-nifra-data": "1" }) })',
      'fetch("/api/users", { marker: "x-nifra-data", headers: { accept: "application/json" } })',
    ]

    expect(calls.map((call) => scanFetchText("a.ts", call).length)).toEqual([1, 1, 1, 1])
  })

  test("skips a declared external-mount prefix (string + template), segment-anchored", () => {
    const mounts = ["/auth"]
    // Blessed: /auth exact, a sub-path, and a dynamic template head - all deliberate, not drift.
    expect(
      scanFetchText("a.ts", 'fetch("/auth/sign-in/email", { method: "POST" })', mounts),
    ).toEqual([])
    expect(scanFetchText("a.ts", 'fetch("/auth")', mounts)).toEqual([])
    expect(scanFetchText("a.ts", "fetch(`/auth/callback/" + "$" + "{provider}`)", mounts)).toEqual(
      [],
    )
    // NOT blessed: /authors is a different route that merely shares a prefix; still flagged.
    expect(scanFetchText("a.ts", 'fetch("/authors")', mounts)).toHaveLength(1)
    // NOT blessed: a `..` traversal escapes the prefix at runtime (/auth/../api/admin -> /api/admin).
    expect(scanFetchText("a.ts", 'fetch("/auth/../api/admin")', mounts)).toHaveLength(1)
    // URL parsing also normalizes percent-encoded dot segments; they must not bypass the same guard.
    expect(scanFetchText("a.ts", 'fetch("/auth/%2e%2e/api/admin")', mounts)).toHaveLength(1)
    // An own-API fetch outside the allowlist is unaffected.
    expect(scanFetchText("a.ts", 'fetch("/users")', mounts)).toHaveLength(1)
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

  test("collects Hono registrations for dual-framework provenance assurance", () => {
    const src = 'import { Hono } from "hono"\nconst app = new Hono().get("/legacy", handler)'
    expect(
      scanStaticRouteText("legacy.ts", src).map((route) => `${route.method} ${route.path}`),
    ).toEqual(["GET /legacy"])
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

  test("does NOT flag server-only imports shown inside comments or code-sample strings", () => {
    const src = [
      '// import { readFile } from "node:fs"',
      'const docs = `import { Database } from "bun:sqlite"`',
      "const inline = 'import postgres from \"postgres\"'",
    ].join("\n")
    expect(scanServerOnlyImports("routes/docs.tsx", src)).toEqual([])
    expect(parseStaticImports(src)).toEqual([])
  })

  test("only applies to routes/ files (server modules may import server-only code freely)", () => {
    const src = 'import { Database } from "bun:sqlite"'
    expect(scanServerOnlyImports("backend.ts", src)).toHaveLength(0)
    expect(scanServerOnlyImports("db/index.ts", src)).toHaveLength(0)
    expect(scanServerOnlyImports("routes/x.tsx", src)).toHaveLength(1)
  })

  test("captures the offending specifier (for the import-chain diagnostic)", () => {
    expect(
      scanServerOnlyImports("routes/notes.tsx", 'import postgres from "postgres"')[0]?.specifier,
    ).toBe("postgres")
    expect(
      scanServerOnlyImports("routes/notes.tsx", 'import { readFileSync } from "node:fs"')[0]
        ?.specifier,
    ).toBe("node:fs")
    expect(
      scanServerOnlyImports("routes/notes.tsx", 'import { db } from "../db"')[0]?.specifier,
    ).toBe("../db")
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
    // The diagnostic names the import chain it can see: the route module → the server-only specifier it
    // top-level-imports (the direct edge; not a transitive graph — see CheckDiagnostic.chain).
    expect(importDiag?.chain).toEqual(["routes/notes.tsx", "../db"])
    expect(importDiag?.message).toContain("routes/notes.tsx → ../db")
    expect(importDiag?.message).toContain('server-only "../db"')
    // The fix references the exact specifier so an agent acts without re-reading the source.
    expect(importDiag?.suggestion?.steps?.join("\n")).toContain('"../db"')
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

  test("a `// nifra-expect raw-response` pragma (same line or line above) suppresses the advisory", () => {
    const src = backend(
      [
        '  .get("/file", () => new Response("x")) // nifra-expect raw-response', // trailing pragma
        "  // nifra-expect raw-response",
        '  .get("/redirect", () => new Response(null, { status: 302 }))', // pragma on the line above
        '  .get("/real", () => new Response("y"))', // no pragma → still flagged
      ].join("\n"),
    )
    const found = scanResponseRoutes("backend.ts", src)
    expect(found).toHaveLength(1)
    expect(found[0]?.snippet).toContain('"/real"')
  })

  test("a TRAILING pragma on one route does NOT leak down and suppress the next route's advisory", () => {
    const src = backend(
      [
        '  .get("/file", () => new Response("x")) // nifra-expect raw-response', // A: intentional (trailing)
        '  .get("/leak", () => Response.json({ secret: 1 }))', // B: real drift on A's line-below - MUST warn
      ].join("\n"),
    )
    const found = scanResponseRoutes("backend.ts", src)
    // A is suppressed (same-line pragma); B is NOT (A's trailing pragma is not a standalone comment line).
    expect(found).toHaveLength(1)
    expect(found[0]?.snippet).toContain('"/leak"')
  })
})

describe("nifra.check.json - external-mount allowlist", () => {
  test("blesses a mounted-auth fetch so the typed-client gate goes green, and echoes the mounts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-check-"))
    await mkdir(join(dir, "routes"), { recursive: true })
    // A relative fetch to a mounted better-auth handler - correct, but own-API, so normally an error.
    await writeFile(
      join(dir, "routes", "session.ts"),
      'export const signIn = () => fetch("/auth/sign-in/email", { method: "POST" })',
    )
    // Without the allowlist: the typed-client rule fails the gate.
    const before = await collectCheckResult(dir)
    expect(before.diagnostics.some((d) => d.rule === "typed-client")).toBe(true)
    expect(before.ok).toBe(false)
    // Declare the mount as intentional external → the finding disappears and the mounts are echoed.
    await writeFile(join(dir, "nifra.check.json"), JSON.stringify({ externalMounts: ["/auth/**"] }))
    const after = await collectCheckResult(dir)
    expect(after.diagnostics.some((d) => d.rule === "typed-client")).toBe(false)
    expect(after.externalMounts).toEqual(["/auth"])
    expect(after.ok).toBe(true)
    await rm(dir, { recursive: true, force: true })
  })

  test("malformed nifra.check.json is a non-fatal warning, allowlist ignored", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-check-"))
    await mkdir(join(dir, "routes"), { recursive: true })
    await writeFile(join(dir, "routes", "session.ts"), 'export const f = () => fetch("/users")')
    await writeFile(join(dir, "nifra.check.json"), "{ not valid json")
    const result = await collectCheckResult(dir)
    const cfg = result.diagnostics.filter((d) => d.rule === "check-config")
    expect(cfg).toHaveLength(1)
    expect(cfg[0]?.severity).toBe("warning")
    // The own-API fetch is still flagged (allowlist ignored), so the config error never hides real drift.
    expect(result.diagnostics.some((d) => d.rule === "typed-client")).toBe(true)
    await rm(dir, { recursive: true, force: true })
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

  test("does NOT flag client examples inside comments or documentation strings", () => {
    const src = [
      '// client("https://example.com")',
      "const docs = 'client(\"https://example.com\")'",
      'const template = `client("https://example.com")`',
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

describe("parseStaticImports — static non-type import specifiers", () => {
  test("collects static imports, skips type-only + dynamic imports", () => {
    const src = [
      'import { a } from "./a.ts"',
      'import type { T } from "./t.ts"', // erased at build → skipped
      'import "../side-effect.ts"',
      'const x = await import("./dyn.ts")', // dynamic → skipped
      'import postgres from "postgres"',
    ].join("\n")
    expect(parseStaticImports(src)).toEqual(["./a.ts", "../side-effect.ts", "postgres"])
  })
})

describe("walkServerOnlyChain — bounded transitive walk over a fake module graph (#4.4)", () => {
  // A fake local module graph: route → ../data → ../db → (node:crypto). `resolve` maps a relative
  // specifier from a file to an absolute key; `read` returns the module source. No real fs.
  const graph: Record<string, string> = {
    "/app/routes/x.tsx": 'import { load } from "../data.ts"\nexport default () => null',
    "/app/data.ts": 'import { query } from "./db.ts"\nexport const load = () => query()',
    "/app/db.ts":
      'import { randomUUID } from "node:crypto"\nexport const query = () => randomUUID()',
  }
  const resolve: ModuleResolver = (from, spec) => {
    // Minimal relative resolver for the fake graph: join the dir of `from` with `spec`, normalising `..`.
    if (!spec.startsWith(".")) return undefined
    const segs = from.split("/").slice(0, -1).concat(spec.split("/"))
    const stack: string[] = []
    for (const s of segs) {
      if (s === "" || s === ".") continue
      if (s === "..") stack.pop()
      else stack.push(s)
    }
    return `/${stack.join("/")}`
  }
  const read: ModuleReader = (abs) => graph[abs]

  test("builds the full chain route → ../data → ../db → node:crypto", () => {
    const chain = walkServerOnlyChain(
      "/app/routes/x.tsx",
      graph["/app/routes/x.tsx"] as string,
      resolve,
      read,
    )
    expect(chain).toEqual(["/app/routes/x.tsx", "../data.ts", "./db.ts", "node:crypto"])
  })

  test("returns undefined when no module in the graph reaches a sink", () => {
    const clean: Record<string, string> = {
      "/app/routes/y.tsx": 'import { x } from "../util.ts"\nexport default () => x',
      "/app/util.ts": 'import { useState } from "react"\nexport const x = 1',
    }
    const chain = walkServerOnlyChain(
      "/app/routes/y.tsx",
      clean["/app/routes/y.tsx"] as string,
      (from, spec) => resolve(from, spec),
      (abs) => clean[abs],
    )
    expect(chain).toBeUndefined()
  })

  test("a *.server dependency terminates the chain by the .server convention", () => {
    const g: Record<string, string> = {
      "/app/routes/z.tsx":
        'import { secret } from "../auth.server.ts"\nexport default () => secret',
    }
    const chain = walkServerOnlyChain(
      "/app/routes/z.tsx",
      g["/app/routes/z.tsx"] as string,
      (from, spec) => resolve(from, spec),
      (abs) => g[abs],
    )
    expect(chain).toEqual(["/app/routes/z.tsx", "../auth.server.ts"])
  })

  test("a server-only-marked dependency terminates the chain", () => {
    const g: Record<string, string> = {
      "/app/routes/m.tsx": 'import { key } from "../secrets.ts"\nexport default () => key',
      "/app/secrets.ts": 'import "@nifrajs/web/server-only"\nexport const key = "x"',
    }
    const chain = walkServerOnlyChain(
      "/app/routes/m.tsx",
      g["/app/routes/m.tsx"] as string,
      (from, spec) => resolve(from, spec),
      (abs) => g[abs],
    )
    expect(chain).toEqual(["/app/routes/m.tsx", "../secrets.ts"])
  })

  test("is cycle-safe (a → b → a) — never loops, returns undefined for no sink", () => {
    const g: Record<string, string> = {
      "/app/routes/c.tsx": 'import { a } from "../a.ts"\nexport default () => a',
      "/app/a.ts": 'import { b } from "./b.ts"\nexport const a = () => b',
      "/app/b.ts": 'import { a } from "./a.ts"\nexport const b = () => a',
    }
    const chain = walkServerOnlyChain(
      "/app/routes/c.tsx",
      g["/app/routes/c.tsx"] as string,
      (from, spec) => resolve(from, spec),
      (abs) => g[abs],
    )
    expect(chain).toBeUndefined()
  })
})

describe("resolveServerOnlyChains — per-route findings with the full chain (#4.4)", () => {
  test("a direct server-only import yields the direct edge (length-2 chain)", () => {
    const finding = resolveServerOnlyChains(
      "routes/x.tsx",
      'import { readFileSync } from "node:fs"',
      () => undefined,
      () => undefined,
    )[0]
    expect(finding?.chain).toEqual(["routes/x.tsx", "node:fs"])
    expect(finding?.fallback).toBe(false)
  })

  test("an unresolvable ../db relative import falls back to the direct edge (fallback: true)", () => {
    const finding = resolveServerOnlyChains(
      "routes/x.tsx",
      'import { db } from "../db"',
      () => undefined, // can't resolve
      () => undefined,
    )[0]
    expect(finding?.chain).toEqual(["routes/x.tsx", "../db"])
    expect(finding?.fallback).toBe(true)
  })

  test("non-route files yield no findings", () => {
    expect(
      resolveServerOnlyChains(
        "src/data.ts",
        'import { readFileSync } from "node:fs"',
        () => undefined,
        () => undefined,
      ),
    ).toEqual([])
  })
})

describe("collectCheckResult — transitive server-only chain end-to-end (#4.4)", () => {
  test("routes/x.tsx → ../data.ts → ../db.ts (node:crypto) yields the full chain", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-check-transitive-"))
    await mkdir(join(dir, "routes"), { recursive: true })
    await writeFile(
      join(dir, "routes", "x.tsx"),
      'import { load } from "../data.ts"\nexport const loader = () => load()\nexport default () => null\n',
    )
    await writeFile(
      join(dir, "data.ts"),
      'import { query } from "./db.ts"\nexport const load = () => query()\n',
    )
    await writeFile(
      join(dir, "db.ts"),
      'import { randomUUID } from "node:crypto"\nexport const query = () => randomUUID()\n',
    )
    const result = await collectCheckResult(dir, { lintsOnly: true })
    const diag = result.diagnostics.find((d) => d.rule === "server-only-import")
    expect(diag).toBeDefined()
    // The FULL transitive chain, matching the build leak-guard's depth.
    expect(diag?.chain).toEqual(["routes/x.tsx", "../data.ts", "./db.ts", "node:crypto"])
    expect(diag?.message).toContain("routes/x.tsx → ../data.ts → ./db.ts → node:crypto")
    expect(diag?.message).toContain('server-only "node:crypto"')
    // The fix surfaces the resolved chain so an agent acts without re-reading the source.
    expect(diag?.suggestion?.steps?.join("\n")).toContain(
      "routes/x.tsx → ../data.ts → ./db.ts → node:crypto",
    )
    expect(result.ok).toBe(false)
    await rm(dir, { recursive: true, force: true })
  })

  test("a direct server-only import still works (the direct edge)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-check-direct-"))
    await mkdir(join(dir, "routes"), { recursive: true })
    await writeFile(
      join(dir, "routes", "x.tsx"),
      'import { readFileSync } from "node:fs"\nexport const loader = () => readFileSync("x")\nexport default () => null\n',
    )
    const result = await collectCheckResult(dir, { lintsOnly: true })
    const diag = result.diagnostics.find((d) => d.rule === "server-only-import")
    expect(diag?.chain).toEqual(["routes/x.tsx", "node:fs"])
    expect(diag?.message).toContain("routes/x.tsx → node:fs")
    await rm(dir, { recursive: true, force: true })
  })

  test("an unresolvable ../db import falls back to the direct edge + says so", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-check-fallback-"))
    await mkdir(join(dir, "routes"), { recursive: true })
    // No db.ts on disk → the relative import can't be resolved → direct-edge fallback.
    await writeFile(
      join(dir, "routes", "x.tsx"),
      'import { db } from "../db"\nexport const loader = () => db.query()\nexport default () => null\n',
    )
    const result = await collectCheckResult(dir, { lintsOnly: true })
    const diag = result.diagnostics.find((d) => d.rule === "server-only-import")
    expect(diag?.chain).toEqual(["routes/x.tsx", "../db"])
    expect(diag?.message).toContain("direct edge")
    expect(result.ok).toBe(false)
    await rm(dir, { recursive: true, force: true })
  })

  test("a clean route (no server-only reach) produces no server-only diagnostic", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-check-clean-"))
    await mkdir(join(dir, "routes"), { recursive: true })
    await writeFile(
      join(dir, "routes", "x.tsx"),
      'import { greet } from "../util.ts"\nexport default () => greet()\n',
    )
    await writeFile(join(dir, "util.ts"), 'export const greet = () => "hi"\n')
    const result = await collectCheckResult(dir, { lintsOnly: true })
    expect(result.diagnostics.find((d) => d.rule === "server-only-import")).toBeUndefined()
    await rm(dir, { recursive: true, force: true })
  })
})

describe("walkSource — respects .gitignore (no huge scans of generated/build trees)", () => {
  test("skips a gitignored dir even though it holds a lintable source file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-check-gi-"))
    Bun.spawnSync(["git", "init", "-q"], { cwd: dir })
    await writeFile(join(dir, ".gitignore"), "generated/\n")
    await mkdir(join(dir, "routes"), { recursive: true })
    await mkdir(join(dir, "generated"), { recursive: true })
    await writeFile(join(dir, "routes", "a.tsx"), 'export const f = () => fetch("/a")')
    await writeFile(join(dir, "generated", "b.tsx"), 'export const g = () => fetch("/b")') // gitignored

    const found = await scanProject(dir)
    expect(found.map((f) => f.file)).toEqual(["routes/a.tsx"]) // generated/b.tsx excluded
    await rm(dir, { recursive: true, force: true })
  })

  test("degrades gracefully outside a git repo — no filtering, never throws", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-check-nogit-")) // NOT a git repo
    await writeFile(join(dir, ".gitignore"), "generated/\n") // present, but git can't consult it here
    await mkdir(join(dir, "routes"), { recursive: true })
    await mkdir(join(dir, "generated"), { recursive: true })
    await writeFile(join(dir, "routes", "a.tsx"), 'export const f = () => fetch("/a")')
    await writeFile(join(dir, "generated", "b.tsx"), 'export const g = () => fetch("/b")')

    // With no git repo, `git check-ignore` can't run → both are scanned (the built-in IGNORED regex still
    // applies; this custom .gitignore entry just isn't honoured). The scan must not throw.
    const found = await scanProject(dir)
    expect(found.map((f) => f.file).sort()).toEqual(["generated/b.tsx", "routes/a.tsx"])
    await rm(dir, { recursive: true, force: true })
  })
})

describe("collectCheckResult — maxDiagnostics bounds the result (MCP transport safety)", () => {
  test("caps diagnostics + reports truncated; ok reflects the FULL set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-check-cap-"))
    await mkdir(join(dir, "src"), { recursive: true })
    for (let i = 0; i < 4; i++) {
      await writeFile(join(dir, "src", `f${i}.ts`), `const r${i} = await fetch("/x${i}")`)
    }

    const full = await collectCheckResult(dir, { lintsOnly: true })
    const total = full.diagnostics.length
    expect(total).toBeGreaterThanOrEqual(4)
    expect(full.truncated).toBeUndefined()

    const capped = await collectCheckResult(dir, { lintsOnly: true, maxDiagnostics: 2 })
    expect(capped.diagnostics).toHaveLength(2)
    expect(capped.truncated).toEqual({ shown: 2, total })
    expect(capped.ok).toBe(false) // truncation never flips ok
    await rm(dir, { recursive: true, force: true })
  })
})
