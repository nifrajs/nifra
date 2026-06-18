#!/usr/bin/env bun
/**
 * Generate `api-reference.md` — the library API reference (every public export of every package: name,
 * kind, signature, and doc summary) extracted from source with the TypeScript compiler API, so it can
 * NEVER drift from the code. This is the symbol-level counterpart to two other generated surfaces:
 * the HTTP route reference (Scalar, from `toOpenAPI(app)`) and `llms-full.txt` (which lists export
 * names). Here we add the actual signatures + doc comments.
 *
 * Run: `bun run gen:api` (also run by `site:build`; served at `/api-reference.md`). `generateApiReference`
 * is exported + guarded by `import.meta.main`, so a test can import it without writing the file.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { Glob } from "bun"
import ts from "typescript"

const ROOT = `${import.meta.dir}/..`
const SIG_CAP = 220

interface Pkg {
  readonly name: string
  readonly entry: string
}

function repoOptions(): ts.CompilerOptions {
  const host: ts.ParseConfigFileHost = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} }
  const parsed = ts.getParsedCommandLineOfConfigFile(`${ROOT}/tsconfig.json`, {}, host)
  return { ...(parsed?.options ?? {}), noEmit: true, skipLibCheck: true }
}

/** Published packages (skip `private`) that expose a `src/index.ts`, sorted by name. */
function publicPackages(): Pkg[] {
  const pkgs: Pkg[] = []
  for (const file of new Glob("packages/*/package.json").scanSync(ROOT)) {
    const json = JSON.parse(readFileSync(`${ROOT}/${file}`, "utf8")) as {
      name?: string
      private?: boolean
    }
    if (json.private === true || json.name === undefined) continue
    const entry = `${ROOT}/${file.replace(/\/package\.json$/, "")}/src/index.ts`
    if (existsSync(entry)) pkgs.push({ name: json.name, entry })
  }
  return pkgs.sort((a, b) => a.name.localeCompare(b.name))
}

function kindOf(decl: ts.Declaration): string {
  if (ts.isFunctionDeclaration(decl)) return "function"
  if (ts.isClassDeclaration(decl)) return "class"
  if (ts.isInterfaceDeclaration(decl)) return "interface"
  if (ts.isTypeAliasDeclaration(decl)) return "type"
  if (ts.isEnumDeclaration(decl)) return "enum"
  return "const"
}

function typeParams(decl: ts.Declaration): string {
  const tp = (decl as { typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> }).typeParameters
  return tp && tp.length > 0 ? `<${tp.map((p) => p.getText()).join(", ")}>` : ""
}

function cap(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim()
  return flat.length > SIG_CAP ? `${flat.slice(0, SIG_CAP - 1)}…` : flat
}

/** A one-line signature for the export, by declaration kind — value types via the checker, declared
 * types by their header (members elided; the source is the full detail). */
function signatureOf(
  name: string,
  sym: ts.Symbol,
  decl: ts.Declaration,
  checker: ts.TypeChecker,
): string {
  if (ts.isInterfaceDeclaration(decl)) return `interface ${name}${typeParams(decl)}`
  if (ts.isClassDeclaration(decl)) return `class ${name}${typeParams(decl)}`
  if (ts.isEnumDeclaration(decl)) return `enum ${name}`
  if (ts.isTypeAliasDeclaration(decl)) {
    const rhs = decl.type.getText()
    const head = `type ${name}${typeParams(decl)}`
    return rhs.length <= SIG_CAP ? cap(`${head} = ${rhs}`) : head
  }
  // function / const → the value type (call signature for functions).
  const type = checker.typeToString(
    checker.getTypeOfSymbolAtLocation(sym, decl),
    decl,
    ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.WriteArrowStyleSignature,
  )
  return cap(`${name}: ${type}`)
}

function summaryOf(sym: ts.Symbol, checker: ts.TypeChecker): string {
  const doc = ts.displayPartsToString(sym.getDocumentationComment(checker)).trim()
  if (doc === "") return ""
  const firstPara = (doc.split(/\n\s*\n/)[0] ?? "").replace(/\s+/g, " ").trim()
  return firstPara.length > 300 ? `${firstPara.slice(0, 299)}…` : firstPara
}

export function generateApiReference(): string {
  const pkgs = publicPackages()
  const program = ts.createProgram(
    pkgs.map((p) => p.entry),
    repoOptions(),
  )
  const checker = program.getTypeChecker()

  const sections: string[] = [
    "# nifra API reference (generated)",
    "Every public export of every package — name, kind, signature, and doc summary — extracted from each `src/index.ts` with the TypeScript compiler API, so it cannot drift from the code. For HTTP route shapes (request/response bodies), see the OpenAPI + Scalar reference your app serves at `/reference`. For prose guides, see `llms-full.txt`.",
  ]

  for (const pkg of pkgs) {
    const sf = program.getSourceFile(pkg.entry)
    const moduleSym = sf ? checker.getSymbolAtLocation(sf) : undefined
    if (!moduleSym) continue
    const lines: string[] = []
    for (const raw of checker.getExportsOfModule(moduleSym)) {
      // Resolve `export { x } from "..."` re-exports to the real declaration.
      const sym = raw.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(raw) : raw
      const decl = sym.getDeclarations()?.[0]
      if (!decl) continue
      const sig = signatureOf(raw.getName(), sym, decl, checker)
      const summary = summaryOf(sym, checker)
      lines.push(
        `- **${raw.getName()}** _(${kindOf(decl)})_ — \`${sig}\`${summary ? `\n  ${summary}` : ""}`,
      )
    }
    if (lines.length > 0) {
      sections.push(`## ${pkg.name}\n\n${lines.sort().join("\n")}`)
    }
  }
  return `${sections.join("\n\n")}\n`
}

/** Sanity-check the output so a broken generator (e.g. a resolution change) fails loudly, not silently. */
function assertSane(out: string): void {
  if (!out.includes("## @nifrajs/core") || !/\*\*server\*\*/.test(out)) {
    throw new Error("api-reference.md generation looks broken (missing @nifrajs/core or `server`)")
  }
}

if (import.meta.main) {
  const out = generateApiReference()
  assertSane(out)
  const target = `${ROOT}/api-reference.md`
  const count = (out.match(/^- \*\*/gm) ?? []).length
  // `--check` is the gate (run by `check:api`): verify the committed file is current, never write.
  if (process.argv.includes("--check")) {
    const current = existsSync(target) ? readFileSync(target, "utf8") : ""
    if (current !== out) {
      console.error("✗ api-reference.md is stale — run `bun run gen:api` and commit the result.")
      process.exit(1)
    }
    console.log(`✓ api-reference.md is up to date (${count} exports)`)
  } else {
    writeFileSync(target, out)
    console.log(`Generated api-reference.md (${count} exports across the public packages).`)
  }
}
