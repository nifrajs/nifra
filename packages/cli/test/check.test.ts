// biome-ignore-all lint/suspicious/noTemplateCurlyInString: SQL scanner fixtures intentionally contain literal interpolation syntax.
import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import ts from "typescript"
import {
  collectCheckResult,
  createSqlImports,
  type ModuleReader,
  type ModuleResolver,
  parseStaticImports,
  resolveServerOnlyChains,
  scanFetchText,
  scanInterpolatedSql,
  scanProject,
  scanProjectSql,
  scanResponseRoutes,
  scanServerManifestDrift,
  scanServerOnlyImports,
  scanStaticRouteText,
  scanUntypedClient,
  stripComments,
  walkServerOnlyChain,
} from "../src/check.ts"
import { createSourceFacts } from "../src/internal/source-facts.ts"
import {
  collectReleaseVerification,
  type ReleaseCommandResult,
  type ReleaseCommandSpec,
  renderReleaseVerification,
  resolveVerificationRoot,
} from "../src/release-verification.ts"
import {
  omittedVerificationGateIds,
  renderVerificationPlan,
  verificationPlan,
  verificationPlanIds,
} from "../src/verification-plan.ts"
import { createFixtureProject, createFixtureRoot, removeFixtureRoot } from "./fixture-root.ts"

describe("release verification", () => {
  test("uses explicit gate IDs so default-plan edits cannot re-point the release plan", () => {
    expect(verificationPlanIds()).toEqual([
      "lint",
      "typecheck",
      "tests",
      "docs",
      "api-corpus",
      "cards-corpus",
      "node-outcome-corpus",
      "sitemap",
      "public-boundary",
      "public-manifest",
      "size",
      "changesets",
    ])
    expect(verificationPlanIds("release")).toEqual([
      "build",
      "lint",
      "typecheck",
      "tests",
      "cli-isolation",
      "coverage",
      "corpus",
      "docs",
      "public-boundary",
      "public-manifest",
      "size",
      "core-performance",
      "publish",
      "consumer",
      "cold-start",
      "cross-runtime-deno",
      "cross-runtime-node",
      "workerd",
      "pipeline-parity",
      "verification-parity",
      "changesets",
    ])
    const release = verificationPlan("release")
    expect(release.find((gate) => gate.id === "docs")?.commands).toEqual([["run", "check:docs"]])
    expect(release.find((gate) => gate.id === "corpus")?.commands).toEqual([
      ["run", "check:corpus"],
    ])
    expect(renderVerificationPlan("release")).toContain("7. corpus: bun run check:corpus")
    expect(Object.isFrozen(release)).toBe(true)
    expect(release.find((gate) => gate.id === "core-performance")?.workflowRequired).toBe(false)
    expect(release.find((gate) => gate.id === "tests")?.workflowRequired).toBe(true)
    expect(omittedVerificationGateIds()).toContain("core-performance")
    expect(omittedVerificationGateIds()).not.toContain("public-manifest")
  })

  test("reports omitted release gates for the default plan", async () => {
    const root = createFixtureRoot("verify-omissions")
    try {
      await Bun.write(join(root, "package.json"), JSON.stringify({ private: true, workspaces: [] }))
      const result = await collectReleaseVerification(root, {
        runCommand: async () => ({ exitCode: 0 }),
      })
      expect(result.omittedReleaseGateIds).toEqual(omittedVerificationGateIds())
      expect(renderReleaseVerification(result)).toContain(
        "run `bun run check:release` for the full release gate.",
      )
    } finally {
      removeFixtureRoot(root)
    }
  })

  test("uses the workspace root when invoked from a subdirectory and runs the default plan", async () => {
    const root = createFixtureRoot("verify-root")
    try {
      await Bun.write(
        join(root, "package.json"),
        JSON.stringify({ private: true, workspaces: ["*"] }),
      )
      const project = createFixtureProject(root, "project-")
      await Bun.write(join(project, "package.json"), JSON.stringify({ name: "project" }))
      expect(await resolveVerificationRoot(project)).toBe(root)

      const calls: ReleaseCommandSpec[] = []
      const fake = async (spec: ReleaseCommandSpec): Promise<ReleaseCommandResult> => {
        calls.push(spec)
        return { exitCode: 0 }
      }
      const result = await collectReleaseVerification(project, { runCommand: fake })
      expect(result.ok).toBe(true)
      expect(result.gates.map((gate) => gate.id)).toEqual([
        "lint",
        "typecheck",
        "tests",
        "docs",
        "api-corpus",
        "cards-corpus",
        "node-outcome-corpus",
        "sitemap",
        "public-boundary",
        "public-manifest",
        "size",
        "changesets",
      ])
      expect(calls.every((call) => call.cwd === root)).toBe(true)
      expect(new Set(calls.map((call) => call.env.NIFRA_VERIFY_GATE)).size).toBe(calls.length)
    } finally {
      removeFixtureRoot(root)
    }
  })

  test("runs coverage before its ratchet and stops after the first failed gate", async () => {
    const root = createFixtureRoot("verify-release")
    try {
      await Bun.write(join(root, "package.json"), JSON.stringify({ private: true, workspaces: [] }))
      const calls: string[] = []
      const fake = async (spec: ReleaseCommandSpec): Promise<ReleaseCommandResult> => {
        calls.push(spec.args.join(" "))
        return {
          exitCode:
            spec.args.join(" ") === "run test:coverage"
              ? 0
              : spec.args.join(" ") === "run check:coverage"
                ? 1
                : 0,
        }
      }
      const result = await collectReleaseVerification(root, { mode: "release", runCommand: fake })
      expect(result.ok).toBe(false)
      expect(calls.indexOf("run test:coverage")).toBeLessThan(calls.indexOf("run check:coverage"))
      expect(result.gates.find((gate) => gate.id === "coverage")?.remediation).toContain(
        "test:coverage",
      )
      expect(result.gates.at(-1)?.status).toBe("skipped")
    } finally {
      removeFixtureRoot(root)
    }
  })
})

describe("scanFetchText - own-API fetch detection", () => {
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
    expect(scanFetchText("a.ts", "fetch(url)")).toHaveLength(0) // variable - undecidable, left alone
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

describe("scanProject - walks source, skips deps/build/tests", () => {
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

describe("scanStaticRouteText - conservative source-only route collection", () => {
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

  test("AST refinement ignores route-shaped text inside ordinary strings", () => {
    const facts = createSourceFacts(ts)
    const src = [
      'import { server } from "@nifrajs/core"',
      "const docs = 'example: app.get(\"/fake\", handler)'",
      'const app = server().get("/real", handler)',
    ].join("\n")
    expect(scanStaticRouteText("backend.ts", src, facts).map((r) => r.path)).toEqual(["/real"])
  })
})

describe("scanServerOnlyImports - server-only imports in route modules", () => {
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

  test("AST refinement ignores inline type-only aliases but keeps dynamic imports out of the scan", () => {
    const facts = createSourceFacts(ts)
    expect(
      scanServerOnlyImports(
        "routes/notes.tsx",
        'import { type DbClient as NotesDb } from "../db"',
        facts,
      ),
    ).toEqual([])
    expect(
      scanServerOnlyImports("routes/notes.tsx", 'const load = () => import("../db")', facts),
    ).toEqual([])
  })
})

describe("collectCheckResult - structured result for --json / the MCP tool", () => {
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
    // top-level-imports (the direct edge; not a transitive graph - see CheckDiagnostic.chain).
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

  test("duplicate-install names each copy's absolute path, version, and importers, and prints both fixes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-check-dup-"))
    try {
      const app = join(dir, "packages", "app")
      await mkdir(join(app, "src"), { recursive: true })
      await mkdir(join(dir, "node_modules", "@nifrajs", "core"), { recursive: true })
      await mkdir(join(app, "node_modules", "@nifrajs", "core"), { recursive: true })
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({
          name: "workspace",
          private: true,
          workspaces: ["packages/*"],
          dependencies: { "@nifrajs/core": "1.12.0" },
        }),
      )
      await writeFile(
        join(app, "package.json"),
        JSON.stringify({ name: "app", dependencies: { "@nifrajs/core": "1.12.0" } }),
      )
      await writeFile(join(app, "src", "x.ts"), 'import { server } from "@nifrajs/core"')
      for (const copy of [dir, app]) {
        await writeFile(
          join(copy, "node_modules", "@nifrajs", "core", "package.json"),
          JSON.stringify({ name: "@nifrajs/core", version: "1.12.0" }),
        )
      }

      const result = await collectCheckResult(dir, { lintsOnly: true })
      const diagnostic = result.diagnostics.find((d) => d.rule === "duplicate-install")
      expect(diagnostic?.severity).toBe("error")
      expect(result.ok).toBe(false)

      // Each physical copy is named with its resolved absolute path, version, and importers.
      const real = await realpath(dir)
      const steps = diagnostic?.suggestion?.steps?.join("\n") ?? ""
      expect(steps).toContain(
        `@nifrajs/core@1.12.0 at ${join(real, "node_modules", "@nifrajs", "core")}`,
      )
      expect(steps).toContain(
        `@nifrajs/core@1.12.0 at ${join(real, "packages", "app", "node_modules", "@nifrajs", "core")}`,
      )
      expect(steps).toContain("pulled in by")
      // Both supported fixes, with the exact single-copy config printed verbatim.
      expect(steps).toContain("Fix 1 - deduplicate")
      expect(steps).toContain("Fix 2 - declare single-copy")
      const diff = diagnostic?.suggestion?.diff ?? ""
      expect(diff).toContain('"nifra": { "singleCopy": ["@nifrajs/core"] }')
      expect(diff).toContain('preload = ["@nifrajs/core/single-copy/register"]')
      expect(diff).toContain("[test]")

      // The machine-readable slice for `--json` consumers.
      const preflight = result.identityPreflight
      expect(preflight).toBeDefined()
      expect(preflight?.duplicates).toHaveLength(1)
      expect(preflight?.deduplicated).toEqual([])
      const copies = preflight?.duplicates[0]?.copies ?? []
      expect(copies).toHaveLength(2)
      for (const copy of copies) {
        expect(copy.version).toBe("1.12.0")
        expect(copy.absolutePath !== undefined && isAbsolute(copy.absolutePath)).toBe(true)
        expect(copy.importers.length).toBeGreaterThan(0)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
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

  test("is advisory in collectCheckResult - surfaced as a warning, does NOT fail the gate", async () => {
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

  test("AST refinement ignores raw-Response text inside ordinary strings", () => {
    const facts = createSourceFacts(ts)
    const src = backend(
      [
        "\nconst docs = 'example: return new Response(\"fake\")'",
        '.get("/real", () => new Response("y"))',
      ].join("\n"),
    )
    const found = scanResponseRoutes("backend.ts", src, facts)
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

describe("stripComments - blank comments + template literals, keep strings + positions", () => {
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

describe("collectCheckResult - doctor integration for undeclared dependencies", () => {
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

// #7 - server-manifest drift. A committed, generated `server-manifest.ts` bakes the route list for a
// disk-less worker; if `routes/` changes but the manifest isn't regenerated, the worker serves a stale
// route table (silent edge break). The check diffs the committed manifest's route imports against the
// live routes/ tree.

/** A generated server-manifest (eager shape) importing the given route files under `./routes/`, with
 * the GENERATED marker the scanner keys on. */
const manifestSource = (routeFiles: readonly string[]): string =>
  [
    "// GENERATED by @nifrajs/web generateServerManifest - route manifest for the disk-less edge",
    'import { buildManifest, type RouteModule } from "@nifrajs/web"',
    // Import specifiers are extensionless (bare-`tsc` portable); the route-map KEYS carry the identity.
    ...routeFiles.map((f, i) => `import * as m${i} from "./routes/${f.replace(/\.[jt]sx?$/, "")}"`),
    "const modules: Record<string, RouteModule> = {",
    ...routeFiles.map((f, i) => `  ${JSON.stringify(f)}: m${i},`),
    "}",
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

describe("collectCheckResult - server-manifest drift rule", () => {
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

describe("parseStaticImports - static non-type import specifiers", () => {
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

describe("walkServerOnlyChain - bounded transitive walk over a fake module graph (#4.4)", () => {
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

  test("is cycle-safe (a → b → a) - never loops, returns undefined for no sink", () => {
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

describe("resolveServerOnlyChains - per-route findings with the full chain (#4.4)", () => {
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

describe("collectCheckResult - transitive server-only chain end-to-end (#4.4)", () => {
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

describe("walkSource - respects .gitignore (no huge scans of generated/build trees)", () => {
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

  test("degrades gracefully outside a git repo - no filtering, never throws", async () => {
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

describe("collectCheckResult - maxDiagnostics bounds the result (MCP transport safety)", () => {
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

/**
 * Interpolating a value into SQL makes it STATEMENT rather than parameter, so anything the caller
 * controls can close the literal and continue as SQL.
 *
 * The false negatives here matter less than the false positives: a rule that fires on the safe,
 * idiomatic form teaches people to ignore it, and then it catches nothing at all. So the tagged
 * template - which is the parameterised form in postgres.js, drizzle and kysely - has to stay silent,
 * and so does anything that merely looks like a query call.
 */
describe("scanInterpolatedSql", () => {
  const scan = (src: string): number => scanInterpolatedSql("a.ts", src, ts).length

  test("flags a value interpolated into a statement", () => {
    expect(scan("db.query(`SELECT * FROM users WHERE id = ${id}`)")).toBe(1)
    expect(scan("await db.execute(`DELETE FROM notes WHERE id = ${req.params.id}`)")).toBe(1)
    expect(scan("conn.prepare(`UPDATE t SET body = ${body} WHERE id = ${id}`)")).toBe(1)
  })

  test("reports the line the call is on", () => {
    // `let`, not `const`: a module `const` now resolves to static text and stays quiet.
    const src = ["let x = 1", "", "db.query(`SELECT * FROM t WHERE id = ${x}`)"].join("\n")
    expect(scanInterpolatedSql("a.ts", src, ts)[0]).toMatchObject({ file: "a.ts", line: 3 })
  })

  describe("same-file const resolution - the shared-projection idiom stays quiet", () => {
    test("a module-scope const string fragment interpolates without flagging", () => {
      const src = [
        'const COLS = "id, name, created_at"',
        "db.query(`SELECT ${COLS} FROM users WHERE id = $1`, [id])",
      ].join("\n")
      expect(scanInterpolatedSql("a.ts", src, ts)).toHaveLength(0)
    })

    test("a module-scope const number interpolates without flagging", () => {
      const src = ["const LIMIT = 50", "db.query(`SELECT id FROM cities LIMIT ${LIMIT}`)"].join(
        "\n",
      )
      expect(scanInterpolatedSql("a.ts", src, ts)).toHaveLength(0)
    })

    test("consts chain: a const built from other consts resolves recursively", () => {
      const src = [
        'const BASE = "id, name"',
        "const COLS = `${BASE}, created_at`",
        "db.query(`SELECT ${COLS} FROM t WHERE id = $1`)",
      ].join("\n")
      expect(scanInterpolatedSql("a.ts", src, ts)).toHaveLength(0)
    })

    test("a literal-branch ternary is static text", () => {
      const src = [
        "db.query(`UPDATE calls SET x = $1${ended ? \", status = 'ended'\" : ''} WHERE id = $2`)",
      ].join("\n")
      expect(scanInterpolatedSql("a.ts", src, ts)).toHaveLength(0)
    })

    test("const + literal ternary + parameter placeholder mix stays quiet", () => {
      const src = [
        'const PAYOUT_COLS = "id, amount, status"',
        'db.query(`SELECT ${PAYOUT_COLS} FROM payouts${setRef ? ", provider_ref = $3" : ""} WHERE id = $1`)',
      ].join("\n")
      expect(scanInterpolatedSql("a.ts", src, ts)).toHaveLength(0)
    })

    test("concatenation with a module const stays quiet too", () => {
      const src = [
        'const COLS = "id, name"',
        'db.query("SELECT " + COLS + " FROM t WHERE id = $1")',
      ].join("\n")
      expect(scanInterpolatedSql("a.ts", src, ts)).toHaveLength(0)
    })

    test("an imported name still flags - it can be anything", () => {
      const src = ['import { COLS } from "./cols.ts"', "db.query(`SELECT ${COLS} FROM t`)"].join(
        "\n",
      )
      expect(scanInterpolatedSql("a.ts", src, ts)).toHaveLength(1)
    })

    test("`let` still flags - it can be reassigned from request data", () => {
      const src = ['let cols = "id"', "db.query(`SELECT ${cols} FROM t`)"].join("\n")
      expect(scanInterpolatedSql("a.ts", src, ts)).toHaveLength(1)
    })

    test("a parameter still flags, and so does a function-scope const from request data", () => {
      const byParam = [
        "function run(cols: string) {",
        "  return db.query(`SELECT ${cols} FROM t`)",
        "}",
      ].join("\n")
      expect(scanInterpolatedSql("a.ts", byParam, ts)).toHaveLength(1)
      const byRequest = [
        "app.get('/x', (c) => {",
        "  const cols = c.query.cols",
        "  return db.query(`SELECT ${cols} FROM t`)",
        "})",
      ].join("\n")
      expect(scanInterpolatedSql("a.ts", byRequest, ts)).toHaveLength(1)
    })

    test("a shadowed name still flags - the module const is not what is read", () => {
      const src = [
        'const COLS = "id, name"',
        "function run(COLS: string) {",
        "  return db.query(`SELECT ${COLS} FROM t`)",
        "}",
      ].join("\n")
      expect(scanInterpolatedSql("a.ts", src, ts)).toHaveLength(1)
    })

    test("a hoisted var in a sibling block still refuses resolution", () => {
      const src = [
        'const COLS = "id, name"',
        "function run(q: unknown) {",
        "  { var COLS = String(q) }",
        "  return db.query(`SELECT ${COLS} FROM t`)",
        "}",
      ].join("\n")
      expect(scanInterpolatedSql("a.ts", src, ts)).toHaveLength(1)
    })

    test("a const whose initializer is a call still flags", () => {
      const src = ["const COLS = readCols()", "db.query(`SELECT ${COLS} FROM t`)"].join("\n")
      expect(scanInterpolatedSql("a.ts", src, ts)).toHaveLength(1)
    })

    test("a resolved const still feeds the keyword scan - hostile SQL in a const plus a dynamic span flags", () => {
      // The keyword lives ONLY in the const; the dynamic span alone carries none - so a flag here
      // proves the resolved const text reached the keyword scan.
      const sink = [
        "const TAIL = 'UNION SELECT secret FROM keys'",
        "db.run(`${TAIL} ${req.query.q}`)",
      ].join("\n")
      expect(scanInterpolatedSql("a.ts", sink, ts)).toHaveLength(1)
    })

    test("a const into a named escape hatch still flags - statement-from-variable is their whole warning", () => {
      const src = ['const Q = "SELECT 1"', "sql.unsafe(Q)"].join("\n")
      expect(scanInterpolatedSql("a.ts", src, ts)).toHaveLength(1)
    })
  })

  /**
   * The argument itself is a bare name. Hoisting a statement into `const q = …` must NOT launder the
   * finding: the scan resolves the argument identifier to its same-file initializer and reads that
   * expression's shape exactly as if it had been written inline at the call.
   */
  describe("argument-identifier resolution - a hoisted statement is scanned inline", () => {
    test("a module-const-hoisted dynamic statement flags, same as inline", () => {
      const src = [
        "const q = `SELECT * FROM users WHERE name = '${userInput}'`",
        "await c.query(q)",
      ].join("\n")
      expect(scanInterpolatedSql("a.ts", src, ts)).toHaveLength(1)
    })

    test("a function-local-hoisted dynamic statement flags, same as inline", () => {
      const src = [
        "async function run(req) {",
        "  const q = `SELECT * FROM users WHERE name = '${req.query.name}'`",
        "  return db.query(q)",
        "}",
      ].join("\n")
      expect(scanInterpolatedSql("a.ts", src, ts)).toHaveLength(1)
    })

    test("a `let` never reassigned resolves and flags", () => {
      const src = ["let q = `SELECT ${x} FROM t`", "db.query(q)"].join("\n")
      expect(scanInterpolatedSql("a.ts", src, ts)).toHaveLength(1)
    })

    test("a reassigned `let` does not resolve - left unflagged, not a false laundering channel", () => {
      const src = ["let q = `SELECT ${x} FROM t`", "q = whatever", "db.query(q)"].join("\n")
      expect(scanInterpolatedSql("a.ts", src, ts)).toHaveLength(0)
    })

    test("transitive: q = a, a = dynamic template - flags", () => {
      const src = [
        "const a = `SELECT * FROM t WHERE id = ${id}`",
        "const q = a",
        "db.query(q)",
      ].join("\n")
      expect(scanInterpolatedSql("a.ts", src, ts)).toHaveLength(1)
    })

    test("a hoisted static const argument passes", () => {
      const src = ['const q = "SELECT id, name FROM users"', "db.query(q)"].join("\n")
      expect(scanInterpolatedSql("a.ts", src, ts)).toHaveLength(0)
    })

    test("a hoisted const-of-consts static argument passes", () => {
      const src = [
        'const COLS = "id, name"',
        "const q = `SELECT ${COLS} FROM users`",
        "db.query(q)",
      ].join("\n")
      expect(scanInterpolatedSql("a.ts", src, ts)).toHaveLength(0)
    })

    test("a hoisted `sql` tagged template argument passes - the values are bound", () => {
      const src = ["const q = sql`SELECT * FROM t WHERE id = ${id}`", "db.query(q)"].join("\n")
      expect(scanInterpolatedSql("a.ts", src, ts)).toHaveLength(0)
    })

    test("a function parameter argument is left unflagged - a statement-taking helper is not a finding", () => {
      const src = ["function run(q) {", "  return db.query(q)", "}"].join("\n")
      expect(scanInterpolatedSql("a.ts", src, ts)).toHaveLength(0)
    })

    test("a nearer local const shadows a same-named module const", () => {
      const dynamicInner = [
        'const q = "SELECT 1 FROM t"',
        "function run(x) {",
        "  const q = `SELECT ${x} FROM t`",
        "  return db.query(q)",
        "}",
      ].join("\n")
      expect(scanInterpolatedSql("a.ts", dynamicInner, ts)).toHaveLength(1)
      const staticInner = [
        "const q = `SELECT ${x} FROM t`",
        "function run() {",
        '  const q = "SELECT 1 FROM t"',
        "  return db.query(q)",
        "}",
      ].join("\n")
      expect(scanInterpolatedSql("a.ts", staticInner, ts)).toHaveLength(0)
    })

    test("a hoisted statement into a named escape hatch still flags", () => {
      const src = ["const q = `SELECT ${x}`", "sql.unsafe(q)"].join("\n")
      expect(scanInterpolatedSql("a.ts", src, ts)).toHaveLength(1)
    })
  })

  describe("sql-dynamic pragma - a reason-carrying opt-out for bound-but-dynamic SQL", () => {
    const genPlaceholders = [
      "const rows = cities.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ')",
      "const q = `INSERT INTO cities (name, country) VALUES ${rows}`",
    ]

    test("generated-placeholder batch insert flags without the pragma", () => {
      const src = [...genPlaceholders, "db.query(q, params)"].join("\n")
      expect(scanInterpolatedSql("a.ts", src, ts)).toHaveLength(1)
    })

    test("the pragma with a reason on the line above silences it", () => {
      const src = [
        ...genPlaceholders,
        "// nifra-expect sql-dynamic: placeholders are generated, every value is bound in params",
        "db.query(q, params)",
      ].join("\n")
      expect(scanInterpolatedSql("a.ts", src, ts)).toHaveLength(0)
    })

    test("a trailing pragma with a reason silences it", () => {
      const src = [
        ...genPlaceholders,
        "db.query(q, params) // nifra-expect sql-dynamic: bound placeholders",
      ].join("\n")
      expect(scanInterpolatedSql("a.ts", src, ts)).toHaveLength(0)
    })

    test("the pragma without a reason does NOT silence - reason is mandatory", () => {
      const src = [...genPlaceholders, "// nifra-expect sql-dynamic:", "db.query(q, params)"].join(
        "\n",
      )
      expect(scanInterpolatedSql("a.ts", src, ts)).toHaveLength(1)
    })

    test("the pragma with no colon does NOT silence", () => {
      const src = [...genPlaceholders, "// nifra-expect sql-dynamic", "db.query(q, params)"].join(
        "\n",
      )
      expect(scanInterpolatedSql("a.ts", src, ts)).toHaveLength(1)
    })

    test("a pragma separated by a blank line does not leak onto the finding", () => {
      const src = [
        "// nifra-expect sql-dynamic: unrelated, far above",
        "",
        ...genPlaceholders,
        "db.query(q, params)",
      ].join("\n")
      expect(scanInterpolatedSql("a.ts", src, ts)).toHaveLength(1)
    })
  })

  /**
   * Cross-module `const` resolution, driven by a VIRTUAL module graph - no filesystem, so these pin the
   * resolution rules themselves rather than a temp directory's layout. The on-disk rules (relative-only,
   * inside the project, real source) get their own tests against `scanProjectSql` below.
   *
   * Every case here is the same question asked twice: does the scan stay quiet only when it can PROVE
   * the fragment is a module-scope `const` string, and does it go straight back to flagging the moment
   * anything about that is unprovable? Resolution can only make this rule quieter, so a form the scan
   * does not understand has to fall out as "unknown", never as "fine".
   */
  describe("imported const resolution", () => {
    /** A loader over an in-memory `{ id: source }` map, resolving `./x` → `x.ts` / `x/index.ts` the way
     * the on-disk loader does, and refusing everything the map does not hold. */
    const virtualImports = (modules: Readonly<Record<string, string>>) =>
      createSqlImports((fromModule, specifier) => {
        if (!specifier.startsWith("./") && !specifier.startsWith("../")) return undefined
        const stack = fromModule.split("/").slice(0, -1)
        for (const part of specifier.split("/")) {
          if (part === "" || part === ".") continue
          if (part === "..") stack.pop()
          else stack.push(part)
        }
        const base = stack.join("/")
        for (const id of [base, `${base}.ts`, `${base}/index.ts`]) {
          const content = modules[id]
          if (content !== undefined) return { id, content }
        }
        return undefined
      })

    const scanWith = (src: string, modules: Readonly<Record<string, string>>): number =>
      scanInterpolatedSql("routes/a.ts", src, ts, virtualImports(modules)).length

    test("an `export const` fragment imported by name stays quiet", () => {
      const src = [
        'import { ORDER_CLAUSE } from "./sql-fragments.ts"',
        "db.query(`SELECT id FROM t ${ORDER_CLAUSE}`)",
      ].join("\n")
      expect(
        scanWith(src, { "routes/sql-fragments.ts": 'export const ORDER_CLAUSE = "ORDER BY id"' }),
      ).toBe(0)
    })

    test("an aliased import resolves to the exported name", () => {
      const src = [
        'import { ORDER_CLAUSE as ORDER } from "./sql-fragments.ts"',
        "db.query(`SELECT id FROM t ${ORDER}`)",
      ].join("\n")
      expect(
        scanWith(src, { "routes/sql-fragments.ts": 'export const ORDER_CLAUSE = "ORDER BY id"' }),
      ).toBe(0)
    })

    test("the two-statement `const X = …; export { X }` form resolves", () => {
      const src = [
        'import { COLS } from "./sql-fragments.ts"',
        "db.query(`SELECT ${COLS} FROM t WHERE id = $1`)",
      ].join("\n")
      expect(
        scanWith(src, {
          "routes/sql-fragments.ts": ['const COLS = "id, name"', "export { COLS }"].join("\n"),
        }),
      ).toBe(0)
    })

    test("a barrel re-export resolves - `export { X } from` and the two-statement pass-through", () => {
      const src = [
        'import { COLS } from "./sql/index.ts"',
        "db.query(`SELECT ${COLS} FROM t WHERE id = $1`)",
      ].join("\n")
      expect(
        scanWith(src, {
          "routes/sql/index.ts": 'export { COLS } from "./fragments.ts"',
          "routes/sql/fragments.ts": 'export const COLS = "id, name"',
        }),
      ).toBe(0)
      expect(
        scanWith(src, {
          "routes/sql/index.ts": ['import { COLS } from "./fragments.ts"', "export { COLS }"].join(
            "\n",
          ),
          "routes/sql/fragments.ts": 'export const COLS = "id, name"',
        }),
      ).toBe(0)
    })

    test("`export * from` resolves, and two sources for one name refuse to guess", () => {
      const src = [
        'import { COLS } from "./sql/index.ts"',
        "db.query(`SELECT ${COLS} FROM t WHERE id = $1`)",
      ].join("\n")
      expect(
        scanWith(src, {
          "routes/sql/index.ts": 'export * from "./fragments.ts"',
          "routes/sql/fragments.ts": 'export const COLS = "id, name"',
        }),
      ).toBe(0)
      // Two star sources exporting the same name is a conflict. Picking one would be a guess, and a
      // guess here silences a finding - so it stays unresolved.
      expect(
        scanWith(src, {
          "routes/sql/index.ts": [
            'export * from "./fragments.ts"',
            'export * from "./other.ts"',
          ].join("\n"),
          "routes/sql/fragments.ts": 'export const COLS = "id, name"',
          "routes/sql/other.ts": 'export const COLS = "id"',
        }),
      ).toBe(1)
    })

    test("the fragment's identifiers read ITS module, not the importing file's", () => {
      // The structural point of the whole feature. Both files declare `DIR`; the importer's is
      // unresolvable. Reading the fragment's initializer against the importer's const map would fail
      // to resolve and flag - and, worse, in the mirror case would resolve to text nobody wrote.
      const src = [
        "const DIR = readDir()",
        'import { ORDER } from "./sql-fragments.ts"',
        "db.query(`SELECT id FROM t ORDER BY name ${ORDER}`)",
      ].join("\n")
      expect(
        scanWith(src, {
          "routes/sql-fragments.ts": ['const DIR = "ASC"', "export const ORDER = `${DIR}`"].join(
            "\n",
          ),
        }),
      ).toBe(0)
    })

    test("an imported const still feeds the keyword scan", () => {
      // The keyword lives ONLY in the imported fragment; the dynamic span carries none. A flag here
      // proves the cross-module text reached the keyword scan rather than vanishing into silence.
      const src = [
        'import { TAIL } from "./sql-fragments.ts"',
        "db.run(`${TAIL} ${req.query.q}`)",
      ].join("\n")
      expect(
        scanWith(src, {
          "routes/sql-fragments.ts": `export const TAIL = 'UNION SELECT secret FROM keys'`,
        }),
      ).toBe(1)
    })

    test("a default export is not resolved", () => {
      const src = [
        'import COLS from "./sql-fragments.ts"',
        "db.query(`SELECT ${COLS} FROM t`)",
      ].join("\n")
      expect(scanWith(src, { "routes/sql-fragments.ts": 'export default "id, name"' })).toBe(1)
    })

    test("a namespace import is not resolved", () => {
      const src = [
        'import * as frag from "./sql-fragments.ts"',
        "db.query(`SELECT ${frag.COLS} FROM t`)",
      ].join("\n")
      expect(scanWith(src, { "routes/sql-fragments.ts": 'export const COLS = "id, name"' })).toBe(1)
    })

    test("an exported `let` is not resolved - it can be reassigned after import", () => {
      const src = [
        'import { COLS } from "./sql-fragments.ts"',
        "db.query(`SELECT ${COLS} FROM t`)",
      ].join("\n")
      expect(scanWith(src, { "routes/sql-fragments.ts": 'export let COLS = "id, name"' })).toBe(1)
      expect(
        scanWith(src, {
          "routes/sql-fragments.ts": ['let COLS = "id, name"', "export { COLS }"].join("\n"),
        }),
      ).toBe(1)
    })

    test("an exported const whose initializer is a call is not resolved", () => {
      const src = [
        'import { COLS } from "./sql-fragments.ts"',
        "db.query(`SELECT ${COLS} FROM t`)",
      ].join("\n")
      expect(scanWith(src, { "routes/sql-fragments.ts": "export const COLS = readCols()" })).toBe(1)
    })

    test("a bare specifier is never followed - the dependency's exports are not ours to prove", () => {
      const src = [
        'import { COLS } from "@your-scope/sql-fragments"',
        "db.query(`SELECT ${COLS} FROM t`)",
      ].join("\n")
      // The virtual loader refuses non-relative specifiers exactly as the on-disk one does.
      expect(scanWith(src, { "@your-scope/sql-fragments": 'export const COLS = "id, name"' })).toBe(
        1,
      )
    })

    test("a module the loader cannot supply leaves the name unresolved", () => {
      const src = ['import { COLS } from "./missing.ts"', "db.query(`SELECT ${COLS} FROM t`)"].join(
        "\n",
      )
      expect(scanWith(src, {})).toBe(1)
    })

    test("a fragment module that does not parse proves nothing", () => {
      const src = [
        'import { COLS } from "./sql-fragments.ts"',
        "db.query(`SELECT ${COLS} FROM t`)",
      ].join("\n")
      expect(scanWith(src, { "routes/sql-fragments.ts": 'export const COLS = "id, name' })).toBe(1)
    })

    test("a re-export cycle terminates instead of recursing", () => {
      const src = ['import { COLS } from "./sql/a.ts"', "db.query(`SELECT ${COLS} FROM t`)"].join(
        "\n",
      )
      expect(
        scanWith(src, {
          "routes/sql/a.ts": 'export { COLS } from "./b.ts"',
          "routes/sql/b.ts": 'export { COLS } from "./a.ts"',
        }),
      ).toBe(1)
    })

    test("a re-export chain past the hop cap is not resolved", () => {
      const src = [
        'import { COLS } from "./sql/a.ts"',
        "db.query(`SELECT ${COLS} FROM t WHERE id = $1`)",
      ].join("\n")
      // a → b → c is inside the cap; a → b → c → d is not.
      expect(
        scanWith(src, {
          "routes/sql/a.ts": 'export { COLS } from "./b.ts"',
          "routes/sql/b.ts": 'export { COLS } from "./c.ts"',
          "routes/sql/c.ts": 'export const COLS = "id, name"',
        }),
      ).toBe(0)
      expect(
        scanWith(src, {
          "routes/sql/a.ts": 'export { COLS } from "./b.ts"',
          "routes/sql/b.ts": 'export { COLS } from "./c.ts"',
          "routes/sql/c.ts": 'export { COLS } from "./d.ts"',
          "routes/sql/d.ts": 'export const COLS = "id, name"',
        }),
      ).toBe(1)
    })

    test("a local binding that shadows the import still flags", () => {
      const src = [
        'import { COLS } from "./sql-fragments.ts"',
        "function run(COLS: string) {",
        "  return db.query(`SELECT ${COLS} FROM t`)",
        "}",
      ].join("\n")
      expect(scanWith(src, { "routes/sql-fragments.ts": 'export const COLS = "id, name"' })).toBe(1)
    })

    test("a type-only import is not a value binding", () => {
      const src = [
        'import type { COLS } from "./sql-fragments.ts"',
        "db.query(`SELECT ${COLS} FROM t`)",
      ].join("\n")
      expect(scanWith(src, { "routes/sql-fragments.ts": 'export const COLS = "id, name"' })).toBe(1)
    })

    test("without a loader an imported name flags - resolution is opt-in", () => {
      const src = [
        'import { COLS } from "./sql-fragments.ts"',
        "db.query(`SELECT ${COLS} FROM t`)",
      ].join("\n")
      expect(scanInterpolatedSql("routes/a.ts", src, ts)).toHaveLength(1)
    })
  })

  /** The on-disk half: the rules that only exist once a specifier has to become a real path. */
  describe("imported const resolution - on disk", () => {
    const withProject = async (
      files: Readonly<Record<string, string>>,
      run: (root: string) => Promise<void>,
    ): Promise<void> => {
      const root = await mkdtemp(join(tmpdir(), "nifra-sqlimports-"))
      try {
        for (const [rel, content] of Object.entries(files)) {
          const abs = join(root, rel)
          await mkdir(join(abs, ".."), { recursive: true })
          await writeFile(abs, content)
        }
        await run(root)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }

    test("resolves a real relative fragment, extensionless and through a barrel", async () => {
      await withProject(
        {
          "app/sql/fragments.ts": 'export const COLS = "id, name"',
          "app/sql/index.ts": 'export * from "./fragments.ts"',
          // Extensionless, `.js`-style (what NodeNext source actually writes), and via the barrel's
          // directory - each has to land on the same file.
          "app/a.ts": [
            'import { COLS } from "./sql/fragments"',
            "db.query(`SELECT ${COLS} FROM t WHERE id = $1`)",
          ].join("\n"),
          "app/b.ts": [
            'import { COLS } from "./sql/fragments.js"',
            "db.query(`SELECT ${COLS} FROM t WHERE id = $1`)",
          ].join("\n"),
          "app/c.ts": [
            'import { COLS } from "./sql"',
            "db.query(`SELECT ${COLS} FROM t WHERE id = $1`)",
          ].join("\n"),
        },
        async (root) => {
          expect(await scanProjectSql(root)).toEqual([])
        },
      )
    })

    test("a fragment outside the project root is not followed", async () => {
      const outer = await mkdtemp(join(tmpdir(), "nifra-sqloutside-"))
      try {
        await mkdir(join(outer, "vendor"), { recursive: true })
        await writeFile(join(outer, "vendor", "fragments.ts"), 'export const COLS = "id, name"')
        await mkdir(join(outer, "app"), { recursive: true })
        await writeFile(
          join(outer, "app", "a.ts"),
          [
            'import { COLS } from "../vendor/fragments.ts"',
            "db.query(`SELECT ${COLS} FROM t WHERE id = $1`)",
          ].join("\n"),
        )
        // The project root is `app/`, so the fragment resolves to a real file that sits OUTSIDE it -
        // source this scan will not read, let alone treat as proof.
        const found = await scanProjectSql(join(outer, "app"))
        expect(found).toHaveLength(1)
      } finally {
        await rm(outer, { recursive: true, force: true })
      }
    })

    test("a declaration file is not followed - it has no initializer to read", async () => {
      await withProject(
        {
          "app/fragments.d.ts": "export declare const COLS: string",
          "app/a.ts": [
            'import { COLS } from "./fragments"',
            "db.query(`SELECT ${COLS} FROM t WHERE id = $1`)",
          ].join("\n"),
        },
        async (root) => {
          expect(await scanProjectSql(root)).toHaveLength(1)
        },
      )
    })
  })

  test("stays silent on a tagged template - that IS the bound form", () => {
    expect(scan("await sql`SELECT * FROM users WHERE id = ${id}`")).toBe(0)
    expect(scan("db.execute(sql`SELECT * FROM users WHERE id = ${id}`)")).toBe(0)
    expect(scan("await db.query(sql`DELETE FROM t WHERE id = ${id}`)")).toBe(0)
  })

  test("does not trust arbitrary tags as parameter binding", () => {
    expect(scan("db.query(String.raw`SELECT * FROM users WHERE id = ${id}`)")).toBe(1)
    expect(scan("db.query(identity`SELECT * FROM users WHERE id = ${id}`)")).toBe(1)
    expect(scan("db.query(untrusted.sql`SELECT * FROM users WHERE id = ${id}`)")).toBe(1)
    // `sqlIdentifiers` was briefly trusted - a name invented for Nifra's own adapters, which is a
    // convention no user has. A name earns trust here by being what drivers already call the thing.
    expect(scan("db.query(sqlIdentifiers`SELECT * FROM t WHERE id = ${id}`)")).toBe(1)
  })

  test("trust is by NAME, which is the documented limit of a scanner with no type checker", () => {
    // Worth pinning rather than leaving implied. `sql` is trusted because postgres.js, drizzle,
    // slonik and Bun's driver all call theirs that, and nothing here can prove a given `sql` binds
    // anything. So a no-op with the name passes: this rule catches mistakes, not an adversary who
    // has read it. Deciding otherwise needs a type checker, which is a different tool.
    expect(
      scan("const sql = (s) => s.raw.join('')\ndb.query(sql`SELECT * FROM t WHERE id = ${x}`)"),
    ).toBe(0)
  })

  test("stays silent on a parameterised statement", () => {
    expect(scan('db.query("SELECT * FROM users WHERE id = ?").get(id)')).toBe(0)
    expect(scan("db.query(`SELECT * FROM users WHERE id = $1`, [id])")).toBe(0)
  })

  test("stays silent on a call that is not SQL", () => {
    // `query`, `get` and `run` are ordinary method names. Requiring a SQL keyword in the literal is
    // what keeps this rule from firing across an entire codebase.
    expect(scan("cache.query(`user:${id}`)")).toBe(0)
    expect(scan("registry.run(`task-${name}`)")).toBe(0)
  })

  test("flags the named escape hatches even without a keyword", () => {
    // Their whole purpose is to take a statement as text; a substitution in one is the exact thing the
    // name is warning about.
    expect(scan("db.$queryRawUnsafe(`${statement}`)")).toBe(1)
    expect(scan("sql.unsafe(`${statement}`)")).toBe(1)
    expect(scan("db.$queryRawUnsafe(statement)")).toBe(1)
    expect(scan("sql.unsafe(req.body.sql)")).toBe(1)
  })

  /**
   * The rule started by inspecting template literals only, so the oldest and most common injection
   * shape walked straight past it: `db.query("SELECT … WHERE id = " + id)`. A quoted string was
   * skipped before the SQL-keyword test ever ran, which meant a codebase predating template literals -
   * or an LLM emitting older-style JS - got a clean `nifra check` on textbook-injectable SQL.
   */
  test("flags SQL assembled by string concatenation", () => {
    expect(scan('db.query("SELECT * FROM users WHERE id = " + req.params.id)')).toBe(1)
    expect(scan("db.query('DELETE FROM notes WHERE id = ' + id)")).toBe(1)
    expect(scan('db.execute("UPDATE t SET body = " + body + " WHERE id = " + id)')).toBe(1)
    expect(scan('db.query(("SELECT * FROM users WHERE id = " + id))')).toBe(1)
    expect(scan("db.query(prefix + id)")).toBe(1)
  })

  test("stays silent on concatenation that is not SQL, or not concatenated", () => {
    // The same keyword requirement that keeps the template arm quiet has to apply here, or the rule
    // fires across every string-building call site in a codebase and gets switched off.
    expect(scan('cache.query("user:" + id)')).toBe(0)
    expect(scan('registry.run("task-" + name)')).toBe(0)
    expect(scan('db.query("SELECT * FROM users WHERE id = ?")')).toBe(0)
  })

  test("a hoisted concatenation is scanned inline - extracting a variable does not launder it", () => {
    // Was silent before argument-identifier resolution: the call site `db.query(q)` said nothing, so the
    // finding could be hidden just by lifting the concatenation to `const q = …`. The scan now resolves
    // the argument to its same-file initializer, so this flags exactly as the inline form does.
    expect(scan('const q = "SELECT * FROM t WHERE id = " + id\ndb.query(q)')).toBe(1)
  })

  test("ignores commented-out and quoted occurrences", () => {
    expect(scan("// db.query(`SELECT * FROM t WHERE id = ${id}`)")).toBe(0)
    expect(scan('const doc = "db.query(`SELECT * FROM t WHERE id = ${id}`)"')).toBe(0)
    expect(scan("/* db.query(`SELECT * FROM t WHERE id = ${id}`) */")).toBe(0)
    expect(scan('db.query("SELECT * FROM users WHERE id = ?" /* + id */)')).toBe(0)
  })

  test("an unterminated template literal does not throw or match", () => {
    expect(() => scan("db.query(`SELECT * FROM t WHERE id = ${id}")).not.toThrow()
    expect(scan("db.query(`SELECT * FROM t WHERE id = ${id}")).toBe(0)
  })
})

/**
 * The interpolated-SQL rule parses with the TypeScript compiler, which is an OPTIONAL peer - the CLI
 * should not force a ~25 MB install on every project, and its own typecheck step already treats `tsc`
 * as something the project provides.
 *
 * Optional makes the reporting the load-bearing part. A rule that cannot run must say so: an empty
 * result is indistinguishable from a clean one, and for this rule "clean" means "no SQL injection was
 * found". Silence there is the worst possible answer.
 */
describe("interpolated-sql without the compiler", () => {
  const projectWithInjection = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-sql-"))
    await mkdir(join(dir, "routes"), { recursive: true })
    await writeFile(
      join(dir, "routes", "notes.ts"),
      "export const f = (id: string) => db.query(`SELECT * FROM notes WHERE id = ${id}`)",
    )
    return dir
  }

  test("with the compiler, the injection is found", async () => {
    const result = await collectCheckResult(await projectWithInjection())
    const sql = result.diagnostics.filter((d) => d.rule === "interpolated-sql")
    expect(sql).toHaveLength(1)
    expect(sql[0]?.severity).toBe("error")
    expect(sql[0]?.file).toBe("routes/notes.ts")
  })

  test("without it, the report says the rule did not run - it never reports clean", async () => {
    const result = await collectCheckResult(await projectWithInjection(), {
      loadTypeScript: async () => undefined,
    })
    const sql = result.diagnostics.filter((d) => d.rule === "interpolated-sql")
    // Exactly one diagnostic, and it is the "did not run" notice rather than a finding or nothing.
    expect(sql).toHaveLength(1)
    expect(sql[0]?.severity).toBe("warning")
    expect(sql[0]?.message).toContain("did NOT run")
    expect(sql[0]?.message).toContain("says nothing about SQL injection")
    expect(sql[0]?.suggestion?.command).toEqual(["bun add -d typescript"])
    // No file/line, because the notice is about the whole run rather than a place in the source.
    expect(sql[0]?.file).toBeUndefined()
  })
})

describe("typecheck gate - project TypeScript resolution", () => {
  test("tsconfig present but no typescript install reachable → failing diagnostic, never a silent skip", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-check-"))
    await writeFile(join(dir, "tsconfig.json"), "{}")
    const result = await collectCheckResult(dir)
    expect(result.typecheck).toBe("skipped")
    expect(result.typecheckNote).toContain("typescript not installed")
    const tc = result.diagnostics.filter((d) => d.rule === "typecheck")
    expect(tc).toHaveLength(1)
    expect(tc[0]?.severity).toBe("error")
    expect(tc[0]?.message).toContain("did NOT run")
    expect(tc[0]?.suggestion?.command).toEqual(["bun", "add", "-d", "typescript"])
    expect(result.ok).toBe(false)
    await rm(dir, { recursive: true, force: true })
  })

  test("typescript hoisted to a PARENT directory is found (monorepo package cwd)", async () => {
    // The literal join(cwd, "node_modules", …) probe this pins down used to skip the gate whenever
    // check ran from a workspace package dir with TypeScript hoisted to the workspace root.
    const root = await mkdtemp(join(tmpdir(), "nifra-check-"))
    const pkg = join(root, "packages", "app")
    await mkdir(join(root, "node_modules", "typescript", "bin"), { recursive: true })
    // Stub tsc (exits 0) - the test verifies RESOLUTION, not the compiler itself.
    await writeFile(join(root, "node_modules", "typescript", "bin", "tsc"), "process.exit(0)\n")
    await mkdir(pkg, { recursive: true })
    await writeFile(join(pkg, "tsconfig.json"), "{}")
    const result = await collectCheckResult(pkg)
    expect(result.typecheck).toBe("pass")
    expect(result.diagnostics.filter((d) => d.rule === "typecheck")).toHaveLength(0)
    await rm(root, { recursive: true, force: true })
  })
})

describe("nifra.check.json rule overrides", () => {
  async function project(rules: unknown): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "nifra-check-"))
    await mkdir(join(dir, "src"), { recursive: true })
    await writeFile(join(dir, "src", "users.ts"), 'const res = await fetch("/users")\n')
    await writeFile(join(dir, "nifra.check.json"), JSON.stringify({ rules }))
    return dir
  }

  test("severity: off drops the finding from both views and flips ok", async () => {
    const dir = await project({ "typed-client": { severity: "off" } })
    const result = await collectCheckResult(dir, { lintsOnly: true })
    expect(result.diagnostics.filter((d) => d.rule === "typed-client")).toHaveLength(0)
    expect(result.structuredDiagnostics?.filter((d) => d.code === "NF-C002")).toHaveLength(0)
    expect(result.ok).toBe(true)
    expect(result.ruleOverrides).toEqual({ "typed-client": { severity: "off" } })
    await rm(dir, { recursive: true, force: true })
  })

  test("an override keyed by NF- code retags the LEGACY view too (one key, both views)", async () => {
    const dir = await project({ "NF-C002": { severity: "warn" } })
    const result = await collectCheckResult(dir, { lintsOnly: true })
    const legacy = result.diagnostics.find((d) => d.rule === "typed-client")
    expect(legacy?.severity).toBe("warning")
    expect(result.structuredDiagnostics?.find((d) => d.code === "NF-C002")?.severity).toBe("warn")
    expect(result.ok).toBe(true)
    await rm(dir, { recursive: true, force: true })
  })

  test("ignore globs drop only matching files; non-matching findings keep failing", async () => {
    const dir = await project({ "typed-client": { ignore: ["src/**"] } })
    await mkdir(join(dir, "app"), { recursive: true })
    await writeFile(join(dir, "app", "other.ts"), 'const r = await fetch("/users")\n')
    const result = await collectCheckResult(dir, { lintsOnly: true })
    const files = result.diagnostics.filter((d) => d.rule === "typed-client").map((d) => d.file)
    expect(files).toEqual(["app/other.ts"])
    expect(result.ok).toBe(false)
    await rm(dir, { recursive: true, force: true })
  })

  test("an invalid entry is skipped with a check-config warning, never silently applied", async () => {
    const dir = await project({ "typed-client": { severity: "silent" } })
    const result = await collectCheckResult(dir, { lintsOnly: true })
    // The bogus severity did NOT suppress or retag the finding.
    expect(result.diagnostics.find((d) => d.rule === "typed-client")?.severity).toBe("error")
    const warning = result.diagnostics.find((d) => d.rule === "check-config")
    expect(warning?.severity).toBe("warning")
    expect(warning?.message).toContain('rules["typed-client"].severity')
    expect(result.ok).toBe(false)
    await rm(dir, { recursive: true, force: true })
  })

  test("severity can also be RAISED - an advisory rule becomes a gate failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-check-"))
    await writeFile(join(dir, "backend.ts"), "export const x = 1\n")
    await mkdir(join(dir, "src"), { recursive: true })
    await writeFile(join(dir, "src", "users.ts"), 'const res = await fetch("/users")\n')
    await writeFile(
      join(dir, "nifra.check.json"),
      JSON.stringify({ rules: { "typed-client": { severity: "info" } } }),
    )
    const result = await collectCheckResult(dir, { lintsOnly: true })
    expect(result.diagnostics.find((d) => d.rule === "typed-client")?.severity).toBe("info")
    expect(result.ok).toBe(true)
    await rm(dir, { recursive: true, force: true })
  })
})

describe("cwd invariance", () => {
  test("verdicts are a function of the project dir, never of the process cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "nifra-check-"))
    const pkg = join(root, "packages", "app")
    await mkdir(join(root, "node_modules", "typescript", "bin"), { recursive: true })
    await writeFile(join(root, "node_modules", "typescript", "bin", "tsc"), "process.exit(0)\n")
    await mkdir(join(pkg, "src"), { recursive: true })
    await writeFile(join(pkg, "tsconfig.json"), "{}")
    await writeFile(join(pkg, "src", "users.ts"), 'const res = await fetch("/users")\n')
    const before = process.cwd()
    try {
      process.chdir(root)
      const fromRoot = await collectCheckResult(pkg)
      process.chdir(tmpdir())
      const fromElsewhere = await collectCheckResult(pkg)
      expect(fromRoot.ok).toBe(fromElsewhere.ok)
      expect(fromRoot.typecheck).toBe(fromElsewhere.typecheck)
      expect(fromRoot.typecheck).toBe("pass")
      expect(fromRoot.diagnostics).toEqual(fromElsewhere.diagnostics)
      expect(fromRoot.diagnostics.map((d) => d.rule)).toEqual(["typed-client"])
    } finally {
      process.chdir(before)
    }
    await rm(root, { recursive: true, force: true })
  })
})
