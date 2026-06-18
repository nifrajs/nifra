#!/usr/bin/env bun
/**
 * Typecheck the documentation's code samples against the REAL packages, so a guide can never show a
 * snippet that no longer compiles (the docs-drift failure mode). Each `site/routes/docs/*.tsx` page
 * defines its code blocks as `const NAME = `...`` template literals; we extract those, keep the ones
 * that (a) import from `@nifrajs/*` — i.e. real framework examples, where API drift actually matters —
 * and (b) contain no JSX (a UI component snippet would need a per-framework JSX runtime to check; those
 * are skipped), then compile them with the repo's own tsconfig (so `@nifrajs/*` resolves to source).
 *
 * Diagnostics are filtered to the snippet files only, so a package's own type setup never adds noise —
 * we report exactly "this documented example doesn't compile against the current API". A snippet can
 * opt out with a `doc-check: skip` comment. Run: `bun run check:docs`. Exits non-zero on any failure.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { basename } from "node:path"
import { Glob } from "bun"
import ts from "typescript"

const ROOT = `${import.meta.dir}/..`
const WORK = `${ROOT}/node_modules/.cache/nifra-doc-check`

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

/** A snippet worth typechecking: it references the framework, isn't a JSX UI fragment, and isn't opted out. */
export function isCheckable(code: string): boolean {
  return (
    /\bfrom\s+['"]@nifrajs\//.test(code) && // a real framework example
    !/<\/[A-Za-z]|\/>/.test(code) && // no JSX (generics like `client<typeof app>` have no `</` or `/>`)
    !/doc-check:\s*skip/.test(code) // explicit opt-out
  )
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
  console.log(`✓ doc samples: ${samples.length} framework examples typecheck against the live API`)
}

// Guard so a test can import the pure helpers without running (and process.exit-ing) the whole check.
if (import.meta.main) main()
