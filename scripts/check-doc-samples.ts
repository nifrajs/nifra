#!/usr/bin/env bun
/**
 * Typecheck the documentation's code samples against the REAL `@nifrajs/*` packages, so a guide can
 * never show a snippet that no longer compiles (the docs-drift failure mode). Each `site/routes/docs/
 * *.tsx` page defines its code blocks as `const NAME = `...`` template literals; we extract those,
 * keep the checkable ones (see below), write each to a temp `.ts` file under `site/`, and compile the
 * batch with the repo's own tsconfig — so `@nifrajs/web`, `@nifrajs/core`, every subpath, etc. resolve
 * to their real types. Diagnostics are filtered to the snippet files only (a package's own source
 * compiling alongside never adds noise), so we report exactly "this documented example doesn't compile
 * against the current API". Run: `bun run check:docs`. Exits non-zero on any failure.
 *
 * ── What gets checked (the fragment model) ──────────────────────────────────────────────────────────
 * The gate guards COMPLETE, copy-pasteable examples — the cookbook snippets an agent or reader lifts
 * whole. A snippet is checked when it is SELF-CONTAINED: it imports from `@nifrajs/*` AND declares every
 * value it references, so it compiles on its own. For those, ANY error fails the gate: a renamed/removed
 * `@nifrajs/*` export, a wrong subpath, a method that no longer exists, or a plain type error (a string
 * assigned to a `number`). That is the whole point — drift becomes a red build.
 *
 * Two kinds of snippet are deliberately EXCLUDED, because compiling them would mean inventing scaffolding
 * the docs intentionally omit (and that scaffolding, not the API, is what would fail):
 *
 *   1. Illustrative FRAGMENTS — a block that shows an API shape using ambient names the page established
 *      in prose or an earlier block (`app`, `c`, `env`, `db`, a prior snippet's `server`/`GetUser`). It
 *      was never meant to stand alone. These opt out with `// doc-check: skip — <one-line reason>`.
 *   2. Snippets whose only un-resolvable imports are THIRD-PARTY libs not installed in the doc sandbox
 *      (`zod`, `postgres`, `better-auth`, `@vitejs/plugin-react`, Workers ambient globals like
 *      `D1Database`) — integration illustrations, not `@nifrajs/*` drift, which is what this gate covers.
 *      Same opt-out marker + reason.
 *
 * ── How an author marks a snippet ───────────────────────────────────────────────────────────────────
 * Default is CHECKED. To exclude, put `// doc-check: skip — <reason>` anywhere in the snippet body. The
 * reason is mandatory by convention (reviewers see WHY it's excluded). NEVER skip a complete example just
 * to get green: if a self-contained snippet fails, the API drifted — fix the SNIPPET to the current API.
 * If a snippet is one missing import/declaration away from self-contained, add it (better docs) rather
 * than skip. The script prints both counts (`N checked / M skipped`) on success so coverage stays visible.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { basename, resolve } from "node:path"
import { Glob } from "bun"
import ts from "typescript"

// `resolve` collapses the `scripts/..` segment: TypeScript normalizes `SourceFile.fileName`, so an
// un-normalized WORK made the `startsWith(WORK)` diagnostic filter below match NOTHING — silently
// dropping every error and turning this gate into a no-op (a broken snippet passed). Both must be the
// same normalized absolute path for the filter to actually keep snippet-file diagnostics.
const ROOT = resolve(import.meta.dir, "..")
// Sandbox the snippets INSIDE site/ — that's the directory that owns the doc pages, and crucially the
// only `node_modules/@nifrajs/*` tree that contains the full set the docs import (web, web-react,
// client, schema, …). Bun installs workspace symlinks into each consuming package's own node_modules,
// NOT the repo root, so a sandbox at the repo ROOT could resolve only the handful of `@nifrajs/*`
// entries listed in the root tsconfig `paths` (core, schema, …) and failed on `@nifrajs/web` and every
// subpath (`@nifrajs/web/server-only`, `/fs`, …) with a bogus "Cannot find module". Placing the
// sandbox under site/ lets node resolution walk up into `site/node_modules/@nifrajs/*`, where every
// package + subpath resolves via its `exports` map (TS picks the `types` condition → built `dist/*.d.ts`).
// Gitignored. `site/` is excluded from the typecheck program's `include`, so these temp files never
// leak into `bun run typecheck`.
const WORK = resolve(ROOT, "site", ".tmp-doc-check")

interface Sample {
  readonly page: string
  readonly name: string
  readonly code: string
}

/** Mirrors gen-llms.ts's `extractCodeConsts` — kept local because importing that script would run its
 * top-level file generation as a side effect. Both read the same `const NAME = `...`` doc-snippet shape. */
export function extractConsts(src: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of src.matchAll(/\bconst\s+(\w+)\s*=\s*`((?:\\.|[^`])*)`/g)) {
    out.set(
      m[1] as string,
      (m[2] as string)
        .replace(/\\`/g, "`")
        .replace(/\\\$\{/g, "${")
        .replace(/\\\\/g, "\\"),
    )
  }
  return out
}

/** A snippet that references `@nifrajs/*` — the universe this gate cares about. The two gates below
 * (`isCheckable`'s JSX and skip-marker filters) only ever NARROW this set; a snippet with no `@nifrajs/*`
 * import is out of scope entirely (a plain `Bun.serve` or migration-from snippet has no API to drift). */
function importsFramework(code: string): boolean {
  return /\bfrom\s+['"]@nifrajs\//.test(code)
}

/** A snippet worth typechecking: it references the framework, isn't a JSX UI fragment, and isn't opted
 * out. JSX UI snippets are excluded because a per-framework JSX runtime would be needed to compile them;
 * the explicit `// doc-check: skip — <reason>` marker excludes illustrative fragments + third-party
 * integration snippets (see the header). Everything else is a self-contained example we DO compile. */
export function isCheckable(code: string): boolean {
  return (
    importsFramework(code) &&
    !/<\/[A-Za-z]|\/>/.test(code) && // no JSX (generics like `client<typeof app>` have no `</` or `/>`)
    !/doc-check:\s*skip/.test(code) // explicit opt-out
  )
}

/** Skipped = a framework snippet that is NOT a JSX UI block (those are out-of-scope, not "skipped") and
 * carries the explicit `doc-check: skip` marker. Counted so the gate reports its real coverage. */
function isSkippedFragment(code: string): boolean {
  return importsFramework(code) && !/<\/[A-Za-z]|\/>/.test(code) && /doc-check:\s*skip/.test(code)
}

function countSkipped(): number {
  let skipped = 0
  for (const file of new Glob("site/routes/docs/*.tsx").scanSync(ROOT)) {
    const src = readFileSync(`${ROOT}/${file}`, "utf8")
    for (const [, code] of extractConsts(src)) if (isSkippedFragment(code)) skipped++
  }
  return skipped
}

function collectSamples(): Sample[] {
  const samples: Sample[] = []
  for (const file of new Glob("site/routes/docs/*.tsx").scanSync(ROOT)) {
    const src = readFileSync(`${ROOT}/${file}`, "utf8")
    for (const [name, code] of extractConsts(src)) {
      if (isCheckable(code)) samples.push({ page: basename(file), name, code })
    }
  }
  return samples
}

function loadRepoOptions(): ts.CompilerOptions {
  const host: ts.ParseConfigFileHost = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} }
  const parsed = ts.getParsedCommandLineOfConfigFile(`${ROOT}/tsconfig.json`, {}, host)
  if (!parsed) throw new Error("could not read tsconfig.json")
  return {
    ...parsed.options,
    noEmit: true,
    skipLibCheck: true,
    // Doc snippets are illustrative — an unused local or param isn't a drift failure.
    noUnusedLocals: false,
    noUnusedParameters: false,
  }
}

function main(): void {
  const samples = collectSamples()
  if (samples.length === 0) {
    console.log("doc samples: nothing checkable found")
    return
  }

  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })
  const byFile = new Map<string, Sample>()
  for (const s of samples) {
    const fileName = `${WORK}/${s.page.replace(/\W/g, "_")}__${s.name}.ts`
    writeFileSync(fileName, s.code)
    byFile.set(fileName, s)
  }

  const program = ts.createProgram([...byFile.keys()], loadRepoOptions())
  // Only diagnostics located IN a snippet file — a package's own source compiling alongside is ignored.
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file?.fileName.startsWith(WORK))
    // A snippet's RELATIVE imports (`./schema`, `../backend`) point at the reader's own files, which
    // don't exist in the sandbox — that's illustration, not @nifrajs API drift (the thing this gate
    // guards). Drop "Cannot find module './…'/'../…'" (TS2307) for relative specifiers only; a missing
    // `@nifrajs/*` or any type error in the snippet's own code is still a real failure.
    .filter((d) => {
      if (d.code !== 2307) return true
      const msg = ts.flattenDiagnosticMessageText(d.messageText, "")
      return !/Cannot find module '\.\.?\//.test(msg)
    })

  const failed = new Set<string>()
  for (const d of diagnostics) {
    const fileName = d.file?.fileName ?? ""
    const s = byFile.get(fileName)
    if (s === undefined) continue
    if (!failed.has(fileName)) {
      console.error(`\n✗ ${s.page} › ${s.name}`)
      failed.add(fileName)
    }
    const where =
      d.file && d.start !== undefined
        ? `:${d.file.getLineAndCharacterOfPosition(d.start).line + 1}`
        : ""
    console.error(`    ${where} ${ts.flattenDiagnosticMessageText(d.messageText, "\n      ")}`)
  }

  rmSync(WORK, { recursive: true, force: true })

  if (failed.size > 0) {
    console.error(
      `\n✗ ${failed.size}/${samples.length} documented sample(s) don't compile against the current API.`,
    )
    process.exit(1)
  }
  const skipped = countSkipped()
  console.log(
    `✓ doc samples: ${samples.length} self-contained example(s) typecheck against the live API` +
      ` (${skipped} fragment(s) skipped via \`doc-check: skip\`)`,
  )
}

// Guard so a test can import the pure helpers without running (and process.exit-ing) the whole check.
if (import.meta.main) main()
