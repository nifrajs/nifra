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
  readonly entries: readonly PkgEntry[]
}

interface PkgEntry {
  readonly importPath: string
  readonly entry: string
}

function repoOptions(): ts.CompilerOptions {
  const host: ts.ParseConfigFileHost = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} }
  const parsed = ts.getParsedCommandLineOfConfigFile(`${ROOT}/tsconfig.json`, {}, host)
  return { ...(parsed?.options ?? {}), noEmit: true, skipLibCheck: true }
}

function sourceEntry(dir: string, target: unknown): string | undefined {
  if (typeof target === "string") {
    const entry = `${dir}/${target.replace(/^\.\//, "")}`
    return target.includes("/src/") && existsSync(entry) ? entry : undefined
  }
  if (target === null || typeof target !== "object") return undefined
  const conditions = target as Record<string, unknown>
  for (const key of ["bun", "deno", "worker", "browser", "import", "default", "types"]) {
    const entry = sourceEntry(dir, conditions[key])
    if (entry !== undefined) return entry
  }
  return undefined
}

/** Published packages (skip `private`) and every source-backed public export subpath. */
function publicPackages(): Pkg[] {
  const pkgs: Pkg[] = []
  for (const file of new Glob("packages/*/package.json").scanSync(ROOT)) {
    const json = JSON.parse(readFileSync(`${ROOT}/${file}`, "utf8")) as {
      name?: string
      private?: boolean
      exports?: unknown
    }
    if (json.private === true || json.name === undefined) continue
    const dir = `${ROOT}/${file.replace(/\/package\.json$/, "")}`
    const entries: PkgEntry[] = []
    if (json.exports !== null && typeof json.exports === "object") {
      for (const [subpath, target] of Object.entries(json.exports as Record<string, unknown>)) {
        if (subpath !== "." && !subpath.startsWith("./")) continue
        const entry = sourceEntry(dir, target)
        if (entry === undefined) continue
        entries.push({
          importPath: subpath === "." ? json.name : `${json.name}/${subpath.slice(2)}`,
          entry,
        })
      }
    }
    const fallback = `${dir}/src/index.ts`
    if (entries.length === 0 && existsSync(fallback)) {
      entries.push({ importPath: json.name, entry: fallback })
    }
    if (entries.length > 0) {
      entries.sort((a, b) =>
        a.importPath === json.name
          ? -1
          : b.importPath === json.name
            ? 1
            : a.importPath.localeCompare(b.importPath),
      )
      pkgs.push({ name: json.name, entries })
    }
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
  const firstPara = (doc.split(/\n\s*\n/)[0] ?? "")
    .replace(/\s+/g, " ")
    // Normalize inline `{@link X }` → `{@link X}`. TypeScript's `displayPartsToString` serializes the
    // space before the closing brace inconsistently across environments (local vs CI), and that one-char
    // shift moves the 300-char truncation point below — making the generated api-reference
    // ENVIRONMENT-DEPENDENT, so a file committed locally fails `check:api` in CI (and vice versa). Collapsing
    // the link spacing to a single canonical form makes the output deterministic everywhere.
    .replace(/\{@(link|linkcode|linkplain)\s+([^}]*?)\s*\}/g, "{@$1 $2}")
    .trim()
  return firstPara.length > 300 ? `${firstPara.slice(0, 299)}…` : firstPara
}

export function generateApiReference(): string {
  const pkgs = publicPackages()
  const program = ts.createProgram(
    pkgs.flatMap((p) => p.entries.map((entry) => entry.entry)),
    repoOptions(),
  )
  const checker = program.getTypeChecker()

  const sections: string[] = [
    "# nifra API reference (generated)",
    "Every public export of every package and documented subpath — name, kind, signature, and doc summary — extracted from each package's `exports` map with the TypeScript compiler API, so it cannot drift from the code. For HTTP route shapes (request/response bodies), see the OpenAPI + Scalar reference your app serves at `/reference`. For prose guides, see `llms-full.txt`.",
  ]

  for (const pkg of pkgs) {
    const entrySections: string[] = []
    for (const entry of pkg.entries) {
      const sf = program.getSourceFile(entry.entry)
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
      const heading = pkg.entries.length > 1 ? `### \`${entry.importPath}\`\n\n` : ""
      entrySections.push(
        `${heading}${lines.length > 0 ? lines.sort().join("\n") : "_No named exports (side-effect entrypoint)._"}`,
      )
    }
    if (entrySections.length > 0) {
      sections.push(`## ${pkg.name}\n\n${entrySections.join("\n\n")}`)
    }
  }
  return `${sections.join("\n\n")}\n`
}

/** Sanity-check the output so a broken generator (e.g. a resolution change) fails loudly, not silently. */
function assertSane(out: string): void {
  if (
    !out.includes("## @nifrajs/core") ||
    !out.includes("### `@nifrajs/core/contract`") ||
    !/\*\*defineContract\*\*/.test(out) ||
    !/\*\*server\*\*/.test(out)
  ) {
    throw new Error("api-reference.md generation looks broken (missing core root/subpath exports)")
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
