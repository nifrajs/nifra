import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, readdirSync } from "node:fs"
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { materializeAll } from "./_scaffold-fixtures.ts"

// Regression guard for the "fresh scaffold fails its own `nifra check`" bug:
// (1) demo backends must lock output shapes with a `response` schema (AGENTS.md doctrine);
// (2) demo loaders must narrow on `res.ok` before touching `res.data` — un-narrowed `data`
//     is `{}` under the typed client, so `res.data?.count` is a compile error.
//
// Two tiers:
//   - static tier (always runs): asserts the template sources carry both fixes;
//   - live tier (SMOKE_SCAFFOLD=1): scaffolds with --link against this monorepo, installs,
//     and runs the real `nifra check` — the full done-gate, too slow for every unit run.

const TEMPLATES_DIR = resolve(import.meta.dir, "..")

// Composed, not read from `template-site-<framework>/`. A site scaffold is assembled from a shared
// base, a framework overlay and eight generated files, so its sources are no longer a directory that
// looks like what a user gets. Grading the composed tree is what keeps this a claim about the artifact.
const { scaffolds, cleanup: cleanupScaffolds } = await materializeAll()
afterAll(cleanupScaffolds)

const COUNTER_SCAFFOLDS = scaffolds.filter(
  (s) => s.label.startsWith("site-") || s.label === "template-isr",
)

/** The module that REGISTERS the demo routes. `backend.ts` composes; it declares nothing itself. */
const routeModule = (label: string): string => (label === "template-isr" ? "page.ts" : "counter.ts")

describe("templates: demo contract is schema-locked and ok-narrowed (static)", () => {
  for (const { label, dir } of COUNTER_SCAFFOLDS) {
    test(`${label} demo routes declare a response schema`, async () => {
      const src = await readFile(join(dir, routeModule(label)), "utf8")
      expect(src).toContain('from "@nifrajs/schema"')
      expect(src).toContain("response:")
      // the un-schema'd 2-arg demo route shape must not come back
      expect(src).not.toMatch(/\.(get|post)\("\/(count|page)",\s*\(\)\s*=>/)
    })

    /**
     * The root stays a pure composition. Reach is computed from the module that registers a route, so
     * a root that both composes and registers hands every route in it the reach of everything merged
     * there - which is what makes the armed `provenance.imports` unusable and a GET route undeclarable.
     */
    test(`${label}/backend.ts composes and registers nothing`, async () => {
      const src = await readFile(join(dir, "backend.ts"), "utf8")
      expect(src).toContain(".merge(")
      expect(src).not.toMatch(/\.(get|post|put|patch|delete)\s*\(/)
    })

    test(`${label} index route narrows on res.ok before res.data`, async () => {
      const routesDir = join(dir, "routes")
      const index = readdirSync(routesDir).find((f) => f.startsWith("index."))
      expect(index).toBeDefined()
      const src = await readFile(join(routesDir, index as string), "utf8")
      expect(src).not.toContain("res.data?.")
      expect(src).toMatch(/res\.ok\s*\?\s*res\.data\./)
    })
  }
})

const SMOKE = process.env.SMOKE_SCAFFOLD === "1"
const roots: string[] = []
afterAll(async () => {
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })))
})

// EXPECT THIS TO FAIL DURING A RELEASE THAT ADDS API THE TEMPLATES USE. The tier deliberately pairs
// local templates with the LAST PUBLISHED packages, so a template using something introduced in the
// release being prepared cannot typecheck until that release is out. It self-resolves on publish -
// `scripts/version.ts` rewrites every template pin to the new version. Before "fixing" a template by
// removing what it uses, check whether the missing symbol is simply unpublished: scaffold once with
// `node_modules/@nifrajs/core` symlinked to `packages/core` and see whether it passes against HEAD.
//
// Live tier scaffolds from the LOCAL template sources but installs PUBLISHED @nifrajs/*
// packages — the exact combination a user gets, and the one that shipped broken (template
// stale vs published client types). --link is deliberately not used: linked source packages
// carry workspace:* interdeps that can't resolve outside this monorepo.
describe.if(SMOKE)(
  "templates: fresh scaffold passes `nifra check` (live, SMOKE_SCAFFOLD=1)",
  () => {
    const CLI = join(import.meta.dir, "../src/cli.ts")

    const cases: Array<{ label: string; args: string[] }> = [
      { label: "site-react", args: ["--template", "site", "--framework", "react"] },
      { label: "isr", args: ["--template", "isr"] },
    ]

    for (const { label, args } of cases) {
      test(
        `${label}: scaffold --link → install → nifra check`,
        async () => {
          // realpath: macOS tmpdir is a symlink (/var/folders → /private/var/folders); bun
          // resolves file: deps against the real path, so the app must live at its real spelling.
          const root = await realpath(await mkdtemp(join(tmpdir(), "nifra-smoke-")))
          roots.push(root)
          const app = join(root, `smoke-${label}`)

          const scaffoldProc = Bun.spawn(["bun", CLI, app, ...args], {
            stdout: "pipe",
            stderr: "pipe",
          })
          expect(await scaffoldProc.exited).toBe(0)

          const install = Bun.spawn(["bun", "install"], {
            cwd: app,
            stdout: "pipe",
            stderr: "pipe",
          })
          const [iout, ierr] = await Promise.all([
            new Response(install.stdout).text(),
            new Response(install.stderr).text(),
          ])
          const icode = await install.exited
          if (icode !== 0) console.error(`[${label}] bun install failed:\n${iout}\n${ierr}`)
          expect(icode).toBe(0)

          const check = Bun.spawn(["bunx", "nifra", "check"], {
            cwd: app,
            stdout: "pipe",
            stderr: "pipe",
          })
          const [out, err] = await Promise.all([
            new Response(check.stdout).text(),
            new Response(check.stderr).text(),
          ])
          const code = await check.exited
          if (code !== 0) console.error(`[${label}] nifra check failed:\n${out}\n${err}`)
          expect(code).toBe(0)
        },
        { timeout: 300_000 },
      )
    }
  },
)

/**
 * The api and fullstack templates keep their app in `src/app.ts`, and it has to stay a composition for
 * the same reason: `provenance.imports` is armed in every template, so a root that registers routes
 * would taint them with the reach of everything it merges - including, the moment a database arrives,
 * a domain write that its GET routes cannot legally declare.
 */
describe("templates: the app root composes rather than registers", () => {
  for (const dir of ["template", "template-fullstack"]) {
    test(`${dir}/src/app.ts registers no routes of its own`, async () => {
      const src = await readFile(join(TEMPLATES_DIR, dir, "src/app.ts"), "utf8")
      expect(src).toContain(".merge(")
      expect(src).not.toMatch(/\.(get|post|put|patch|delete)\s*\(/)
    })
  }
})

/**
 * A template that ships `nifra.assurance.ts` ships an ARMED gate: the policy refuses an unauthenticated
 * write, an unbounded mutation, and a route reaching a database it never declared.
 *
 * All eight shipped it and none could run it - no `check` script anywhere, and the two backend
 * templates did not even depend on `@nifrajs/cli`, so `nifra check` was not on PATH. The commit that
 * armed the firewall claimed the chain held "so nobody has to remember anything"; in the delivered
 * artifact everything still depended on remembering, including remembering to install the tool.
 */
describe("templates: a shipped assurance config comes with a way to run it", () => {
  const withAssurance = scaffolds.filter((s) => existsSync(join(s.dir, "nifra.assurance.ts")))

  test("there are templates to check", () => {
    expect(withAssurance.length).toBeGreaterThan(0)
  })

  for (const { label, dir } of withAssurance) {
    test(`${label} has a check script and can resolve the CLI`, async () => {
      const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
        scripts?: Record<string, string>
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
      }
      expect(pkg.scripts?.check).toContain("nifra check")
      expect(pkg.scripts?.check).toContain("nifra assure")
      const deps = { ...pkg.dependencies, ...pkg.devDependencies }
      expect(Object.keys(deps)).toContain("@nifrajs/cli")
    })
  }
})
