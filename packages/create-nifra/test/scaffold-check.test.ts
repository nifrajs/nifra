import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { readdirSync } from "node:fs"

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
const SITE_TEMPLATES = readdirSync(TEMPLATES_DIR).filter((d) => d.startsWith("template-site"))
const COUNTER_TEMPLATES = [...SITE_TEMPLATES, "template-isr"]

describe("templates: demo contract is schema-locked and ok-narrowed (static)", () => {
  for (const dir of COUNTER_TEMPLATES) {
    test(`${dir}/backend.ts declares a response schema`, async () => {
      const src = await readFile(join(TEMPLATES_DIR, dir, "backend.ts"), "utf8")
      expect(src).toContain('from "@nifrajs/schema"')
      expect(src).toContain("response:")
      // the un-schema'd 2-arg demo route shape must not come back
      expect(src).not.toMatch(/\.(get|post)\("\/(count|page)",\s*\(\)\s*=>/)
    })

    test(`${dir} index route narrows on res.ok before res.data`, async () => {
      const routesDir = join(TEMPLATES_DIR, dir, "routes")
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

// Live tier scaffolds from the LOCAL template sources but installs PUBLISHED @nifrajs/*
// packages — the exact combination a user gets, and the one that shipped broken (template
// stale vs published client types). --link is deliberately not used: linked source packages
// carry workspace:* interdeps that can't resolve outside this monorepo.
describe.if(SMOKE)("templates: fresh scaffold passes `nifra check` (live, SMOKE_SCAFFOLD=1)", () => {
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

        const install = Bun.spawn(["bun", "install"], { cwd: app, stdout: "pipe", stderr: "pipe" })
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
})
