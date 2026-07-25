#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename } from "node:path"
/**
 * Generate `llms.txt` (the llmstxt.org index) + `llms-full.txt` (the full single-document reference)
 * from the codebase, so they never drift from the docs:
 *
 *   - `llms.txt`    — auto-built from each `site/routes/docs/*.tsx` page's `pageMeta(title, description)`
 *                     and each `packages/*` `package.json`.
 *   - `llms-full.txt` — a curated preamble + every doc page extracted `.tsx → markdown` (prose + the
 *                     `<CodeBlock>` code) + every package `README.md` + a generated export index
 *                     parsed from each package's `src/index.ts` (the anti-staleness guarantee: every
 *                     public symbol is listed even if prose lags).
 *
 * Run: `bun run gen:llms` (also run by `site:build` so deployed copies are always fresh).
 * The site serves them at `/llms.txt` + `/llms-full.txt` (see site/build.ts).
 */
import { Glob } from "bun"
import ts from "typescript"

const ROOT = `${import.meta.dir}/..`

const SUMMARY =
  "nifra is a Bun-native, contract-first, framework-agnostic full-stack TypeScript framework. The HTTP core (`@nifrajs/core`) is a radix-routed, fully type-inferred server whose handler types flow to a never-throwing client (`@nifrajs/client`) with zero codegen — and graduate to a versionable contract without rewriting handlers. The whole lifecycle is `app.fetch(Request): Response`, so the same app runs on Bun, Node, Deno, and Cloudflare Workers. `@nifrajs/web` adds a framework-agnostic SSR layer (file routing, loaders/actions, streaming, SSG/ISR) with React, Solid, Vue, Svelte, and Preact adapters."

const SYSTEM =
  "This is the full developer documentation for nifra — a Bun-native, contract-first, framework-agnostic full-stack TypeScript framework. nifra is new and unlikely to appear in your training data; treat this document as the source of truth for its API. Code is TypeScript, ESM-only."

// Always-true rules an LLM cannot infer from signatures alone.
const CONVENTIONS = `## Conventions (always true)

- **ESM-only.** Bun is the first-class runtime (\`app.listen(port)\` → \`Bun.serve\`); every other runtime uses \`app.fetch\`. No CommonJS.
- **The client never throws.** Every \`@nifrajs/client\` call returns \`{ ok, status, data, error }\` — branch on it, don't try/catch.
- **Validate at the boundary.** Per-route \`body\`/\`query\`/\`params\`/\`headers\`/\`response\` is any Standard Schema (zod/valibot/arktype) or \`@nifrajs/schema\`'s \`t\`; invalid input → structured \`422\` before the handler runs.
- **Secure by default.** Body-size cap, \`requestTimeoutMs\` + \`c.signal\`, graceful shutdown, redacting logger, same-origin \`redirect()\`, constant-time secret comparison, fail-closed middleware.
- **Money** in integer minor units; **time** parsed to absolute UTC at the boundary.
- Throwing a \`Response\` anywhere in the lifecycle is control flow (returned as-is), not an error.`

// Reading order for the docs index + the extracted full reference. Pages not listed are appended
// alphabetically, so a NEW doc page still shows up automatically (just at the end).
const DOC_ORDER = [
  "index",
  "comparison",
  "routing",
  "api",
  "data",
  "server-functions",
  "mutations",
  "rendering",
  "hydration",
  "streaming",
  "query",
  "frameworks",
  "plugins",
  "security",
  "capabilities",
  "auth",
  "images",
  "i18n",
  "edge",
  "websockets",
  "deployment",
  "cli",
  "agents",
  "dev",
  "troubleshooting",
]

interface DocPage {
  readonly slug: string
  readonly route: string
  readonly title: string
  readonly description: string
  readonly markdown: string
}

const read = (path: string): string => readFileSync(path, "utf8")

/** `pageMeta("title", "description")` → the two strings. */
function extractMeta(src: string): { title: string; description: string } {
  const m = src.match(/pageMeta\(\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"/)
  const unesc = (s: string): string => s.replace(/\\"/g, '"').replace(/\\n/g, " ")
  return { title: m ? unesc(m[1]!) : "", description: m ? unesc(m[2]!) : "" }
}

/** `const NAME = \`…code…\`` → map of name → code (template literals; unescape \\\` and \\${). */
function extractCodeConsts(src: string): Map<string, string> {
  const out = new Map<string, string>()
  const re = /\bconst\s+(\w+)\s*=\s*`((?:[^`\\]|\\.)*)`/g
  for (const m of src.matchAll(re)) {
    const code = m[2]!
      .replace(/\\`/g, "`")
      .replace(/\\\$\{/g, "${")
      .replace(/\\\\/g, "\\")
    out.set(m[1]!, code)
  }
  return out
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
}

/** Resolve simple JSX expression containers in prose: {" "} → space, {"text"} → text, {`x`} → x. */
function resolveExpressions(s: string): string {
  return s
    .replace(/\{"\s*"\}/g, " ")
    .replace(/\{"((?:[^"\\]|\\.)*)"\}/g, (_, t) => t.replace(/\\"/g, '"'))
    .replace(/\{`((?:[^`\\]|\\.)*)`\}/g, (_, t) => t)
}

/** A line that's leftover JSX-expression residue (e.g. a `{ARRAY.map((x) => (` data table that the
 * converter can't evaluate) rather than prose. Dropped during conversion — runs while code blocks are
 * still placeholders, so real code is never matched. Keeps blank lines + fence placeholders. */
function isJsxResidue(line: string): boolean {
  if (line === "" || /^@@FENCE\d+@@$/.test(line)) return false
  if (/^\{[\w$]+(?:\.[\w$]+)*(?:\.map\b|\()/.test(line)) return true // {FRAMEWORKS.map((f) => (  {fn(
  if (/^`?\{[\w$]+(?:\.[\w$]+)+\}`?$/.test(line)) return true // {f.name}  `{f.pkg}`
  if (/^[)\]}]+[);,]*$/.test(line)) return true // ))}  )}  )  };
  return false
}

/** Convert a doc page's JSX component body to markdown. Code blocks are pulled out as placeholders
 * BEFORE prose transforms so their raw `<`/`>`/`&`/`{}` survive untouched, then restored as fences. */
function jsxToMarkdown(src: string, consts: Map<string, string>): string {
  // Strip the code-block consts (template literals) FIRST — their example snippets contain
  // `export default function` / `return (` that would otherwise be mistaken for the real component.
  const stripped = src.replace(/\bconst\s+\w+\s*=\s*`(?:[^`\\]|\\.)*`/g, "")
  const compStart = stripped.search(/export\s+default/)
  const start = stripped.indexOf("return (", compStart < 0 ? 0 : compStart)
  if (start < 0) return ""
  let body = stripped.slice(start + "return (".length, stripped.lastIndexOf(")"))

  // 1. Protect code: <CodeBlock code={NAME} /> → placeholder.
  const fences: string[] = []
  body = body.replace(/<CodeBlock\s+code=\{(\w+)\}[^>]*\/>/g, (_, name) => {
    const code = consts.get(name) ?? ""
    fences.push(`\`\`\`ts\n${code.trim()}\n\`\`\``)
    return `\n\n@@FENCE${fences.length - 1}@@\n\n`
  })

  // 2. Headings (drop the page <h1>, which duplicates the meta title we emit above).
  body = body
    .replace(/<h1[^>]*>[\s\S]*?<\/h1>/g, "")
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/g, "\n\n### $1\n\n")
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/g, "\n\n#### $1\n\n")
  // 3. Links, lists, paragraphs.
  body = body
    .replace(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g, "[$2]($1)")
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/g, "\n- $1")
    .replace(/<\/?(?:ul|ol)[^>]*>/g, "\n")
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/g, "\n\n$1\n\n")
  // 4. Inline emphasis + code → markdown.
  body = body
    .replace(/<\/?(?:b|strong)>/g, "**")
    .replace(/<\/?(?:i|em)>/g, "_")
    .replace(/<code>([\s\S]*?)<\/code>/g, (_, t) => `\`${resolveExpressions(t)}\``)
  // 5. Resolve remaining JSX expressions, strip leftover tags, decode entities.
  body = resolveExpressions(body)
    .replace(/<[^>]+>/g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  body = decodeEntities(body)
  // 6. Normalize whitespace WHILE fences are still placeholders, so trimming the JSX indentation off
  // prose lines (4-space lead would otherwise read as a markdown code block) never touches the code.
  body = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !isJsxResidue(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
  // Then restore the fenced code blocks verbatim (their own indentation preserved).
  body = body.replace(/@@FENCE(\d+)@@/g, (_, i) => fences[Number(i)] ?? "")
  return body.trim()
}

/** Identifiers a package's `src/index.ts` re-exports (values + types), sorted + de-duped. */
function exportsOf(indexSrc: string): string[] {
  const names = new Set<string>()
  for (const m of indexSrc.matchAll(
    /export\s+(?:async\s+)?(?:function|const|class|interface|type|enum)\s+(\w+)/g,
  )) {
    names.add(m[1]!)
  }
  for (const m of indexSrc.matchAll(/export\s+(?:type\s+)?\{([\s\S]*?)\}/g)) {
    for (const raw of m[1]!.split(",")) {
      const name = raw
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)
        .pop()
        ?.trim()
      if (name && /^\w+$/.test(name)) names.add(name)
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b))
}

// ---- gather sources ----------------------------------------------------------------------------

/** A doc snippet worth shipping as a verified example: it references the framework and isn't a JSX UI
 * fragment (those need a per-framework runtime to typecheck) or opted out. Mirrors check-doc-samples.ts's
 * `isCheckable` — every shipped example is one `check:docs` compiles against the live API, so the
 * `nifra_example` MCP tool can never hand an agent a snippet that no longer builds. */
function isCheckableExample(code: string): boolean {
  return (
    /\bfrom\s+['"]@nifrajs\//.test(code) &&
    !/<\/[A-Za-z]|\/>/.test(code) &&
    !/doc-check:\s*skip/.test(code)
  )
}

interface Example {
  readonly name: string
  readonly topic: string
  readonly slug: string
  readonly code: string
}

const docs: DocPage[] = []
const examples: Example[] = []
for (const file of new Glob("site/routes/docs/*.tsx").scanSync(ROOT)) {
  const slug = basename(file, ".tsx")
  if (slug.startsWith("_")) continue // _layout etc.
  const src = read(`${ROOT}/${file}`)
  const { title, description } = extractMeta(src)
  const consts = extractCodeConsts(src)
  for (const [name, code] of consts) {
    if (isCheckableExample(code)) examples.push({ name, topic: title, slug, code: code.trim() })
  }
  docs.push({
    slug,
    route: slug === "index" ? "/docs" : `/docs/${slug}`,
    title,
    description,
    markdown: jsxToMarkdown(src, consts),
  })
}
docs.sort((a, b) => {
  const ia = DOC_ORDER.indexOf(a.slug)
  const ib = DOC_ORDER.indexOf(b.slug)
  return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.slug.localeCompare(b.slug)
})

interface Pkg {
  readonly name: string
  readonly description: string
  readonly dir: string
}
const pkgs: Pkg[] = []
for (const file of new Glob("packages/*/package.json").scanSync(ROOT)) {
  const json = JSON.parse(read(`${ROOT}/${file}`)) as { name?: string; description?: string }
  if (!json.name) continue
  pkgs.push({
    name: json.name,
    description: json.description ?? "",
    dir: `${ROOT}/${file.replace(/\/package\.json$/, "")}`,
  })
}
pkgs.sort((a, b) => a.name.localeCompare(b.name))

// ---- types index (for the `nifra_types` MCP tool) ----------------------------------------------
// The EXACT TypeScript of every exported symbol, parsed from each package's BUILT `dist/**/*.d.ts`
// (signatures only — no impl) with the TS compiler, so it's the authoritative source, never prose and
// never truncated. An agent calls `nifra_types({ name })` for the literal declaration instead of
// reading `.d.ts` files. Requires the packages to be built (`site:build`/`check:publish` build first).

interface TypeEntry {
  readonly name: string
  readonly kind: "interface" | "type" | "class" | "function" | "enum" | "const"
  readonly package: string
  /** The literal declaration text from the `.d.ts` (a clean signature — no implementation). */
  readonly signature: string
  /** The declaration's JSDoc block, if any. */
  readonly doc?: string
}

function leadingJsDoc(text: string, start: number): string | undefined {
  const ranges = ts.getLeadingCommentRanges(text, start)
  if (!ranges) return undefined
  for (let i = ranges.length - 1; i >= 0; i--) {
    const r = ranges[i]
    if (r === undefined) continue
    const comment = text.slice(r.pos, r.end)
    if (comment.startsWith("/**")) return comment
  }
  return undefined
}

function declaredName(stmt: ts.Statement): { name: string; kind: TypeEntry["kind"] } | undefined {
  if (ts.isInterfaceDeclaration(stmt)) return { name: stmt.name.text, kind: "interface" }
  if (ts.isTypeAliasDeclaration(stmt)) return { name: stmt.name.text, kind: "type" }
  if (ts.isClassDeclaration(stmt) && stmt.name) return { name: stmt.name.text, kind: "class" }
  if (ts.isFunctionDeclaration(stmt) && stmt.name) return { name: stmt.name.text, kind: "function" }
  if (ts.isEnumDeclaration(stmt)) return { name: stmt.name.text, kind: "enum" }
  if (ts.isVariableStatement(stmt)) {
    const decl = stmt.declarationList.declarations[0]
    if (decl && ts.isIdentifier(decl.name)) return { name: decl.name.text, kind: "const" }
  }
  return undefined
}

/** What one `.d.ts` declares, where its other names come from, and which of them it exports. */
interface ModuleFacts {
  readonly sf: ts.SourceFile
  readonly text: string
  /** Declared in this file, whether or not it is exported from it. */
  readonly locals: Map<string, ts.Statement>
  /** Name as used here -> the module it came from and the name it has THERE. */
  readonly from: Map<string, { spec: string; original: string }>
  /** `export * from "..."` specifiers. */
  readonly stars: string[]
  /** Names this module exports under. */
  readonly exported: Set<string>
}

const moduleCache = new Map<string, ModuleFacts | undefined>()

function factsOf(file: string): ModuleFacts | undefined {
  const cached = moduleCache.get(file)
  if (cached !== undefined || moduleCache.has(file)) return cached
  if (!existsSync(file)) {
    moduleCache.set(file, undefined)
    return undefined
  }
  const text = read(file)
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true)
  const facts: ModuleFacts = {
    sf,
    text,
    locals: new Map(),
    from: new Map(),
    stars: [],
    exported: new Set(),
  }
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) {
      const bindings = stmt.importClause?.namedBindings
      if (bindings && ts.isNamedImports(bindings) && ts.isStringLiteral(stmt.moduleSpecifier)) {
        for (const el of bindings.elements) {
          facts.from.set(el.name.text, {
            spec: stmt.moduleSpecifier.text,
            original: (el.propertyName ?? el.name).text,
          })
        }
      }
      continue
    }
    if (ts.isExportDeclaration(stmt)) {
      const spec =
        stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)
          ? stmt.moduleSpecifier.text
          : undefined
      if (stmt.exportClause === undefined) {
        if (spec !== undefined) facts.stars.push(spec)
        continue
      }
      if (!ts.isNamedExports(stmt.exportClause)) continue
      for (const el of stmt.exportClause.elements) {
        facts.exported.add(el.name.text)
        if (spec !== undefined) {
          facts.from.set(el.name.text, { spec, original: (el.propertyName ?? el.name).text })
        } else if (el.propertyName !== undefined) {
          // `export { local as Public }` - the name to chase is the local one.
          const source = facts.from.get(el.propertyName.text)
          if (source !== undefined) facts.from.set(el.name.text, source)
        }
      }
      continue
    }
    const declared = declaredName(stmt)
    if (declared === undefined) continue
    facts.locals.set(declared.name, stmt)
    const isExported = ts.canHaveModifiers(stmt)
      ? ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      : false
    if (isExported === true) facts.exported.add(declared.name)
  }
  moduleCache.set(file, facts)
  return facts
}

/**
 * Resolve a specifier from a `.d.ts` to the `.d.ts` it names: `./x.js` -> `x.d.ts`, and a sibling
 * workspace package -> that package's entry for the subpath. The cross-package case is not an extra:
 * `@nifrajs/env` re-exports `StandardIssue` from `@nifrajs/core`, and a consumer really can import it
 * from either, so both belong in the index.
 */
function resolveDts(fromFile: string, spec: string): string | undefined {
  if (spec.startsWith(".")) {
    const base = `${fromFile.slice(0, fromFile.lastIndexOf("/"))}/${spec.replace(/\.js$/, "")}`
    for (const candidate of [`${base}.d.ts`, `${base}/index.d.ts`]) {
      if (existsSync(candidate)) return candidate
    }
    return undefined
  }
  const parts = spec.split("/")
  const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] as string)
  const dir = pkgDirs.get(name)
  if (dir === undefined) return undefined
  const subpath = spec === name ? "." : `.${spec.slice(name.length)}`
  const manifest = JSON.parse(read(`${dir}/package.json`)) as { exports?: Record<string, unknown> }
  const declared = new Set<string>()
  declaredEntries(manifest.exports?.[subpath], declared)
  for (const entry of declared) {
    const file = `${dir}/${entry.replace(/^\.\//, "")}`
    if (existsSync(file)) return file
  }
  return undefined
}

/** Every name a module exports, following `export *`. */
function exportedNamesOf(file: string, visited = new Set<string>()): Set<string> {
  const names = new Set<string>()
  if (visited.has(file)) return names
  visited.add(file)
  const facts = factsOf(file)
  if (facts === undefined) return names
  for (const name of facts.exported) names.add(name)
  for (const spec of facts.stars) {
    const target = resolveDts(file, spec)
    if (target !== undefined) for (const n of exportedNamesOf(target, visited)) names.add(n)
  }
  return names
}

/** Find where a publicly-exported name is actually DECLARED, following re-exports and imports. */
function declarationOf(
  file: string,
  name: string,
  visited = new Set<string>(),
): { facts: ModuleFacts; stmt: ts.Statement } | undefined {
  const key = `${file}#${name}`
  if (visited.has(key)) return undefined
  visited.add(key)
  const facts = factsOf(file)
  if (facts === undefined) return undefined
  const local = facts.locals.get(name)
  if (local !== undefined) return { facts, stmt: local }
  const source = facts.from.get(name)
  if (source !== undefined) {
    const target = resolveDts(file, source.spec)
    if (target !== undefined) return declarationOf(target, source.original, visited)
  }
  for (const spec of facts.stars) {
    const target = resolveDts(file, spec)
    if (target === undefined) continue
    const found = declarationOf(target, name, visited)
    if (found !== undefined) return found
  }
  return undefined
}

function extractTypesFromDts(
  pkgName: string,
  file: string,
  seen: Set<string>,
  out: TypeEntry[],
): void {
  for (const name of [...exportedNamesOf(file)].sort((a, b) => a.localeCompare(b))) {
    if (seen.has(`${pkgName}:${name}`)) continue
    const found = declarationOf(file, name)
    if (found === undefined) continue
    const kind = declaredName(found.stmt)?.kind
    if (kind === undefined) continue
    seen.add(`${pkgName}:${name}`)
    const doc = leadingJsDoc(found.facts.text, found.stmt.getFullStart())
    out.push({
      name,
      kind,
      package: pkgName,
      signature: found.stmt.getText(found.facts.sf).trim(),
      ...(doc ? { doc } : {}),
    })
  }
}

/** Workspace package name -> its directory, so a cross-package re-export can be followed. */
const pkgDirs = new Map(pkgs.map((p) => [p.name, p.dir]))

/** Every `./dist/....d.ts` target named anywhere in a package's `exports` map, at any condition depth. */
function declaredEntries(exportsMap: unknown, out: Set<string>): void {
  if (typeof exportsMap === "string") {
    if (exportsMap.endsWith(".d.ts")) out.add(exportsMap)
    return
  }
  if (exportsMap === null || typeof exportsMap !== "object") return
  for (const value of Object.values(exportsMap)) declaredEntries(value, out)
}

/**
 * The `.d.ts` entry points a package publishes - one per subpath in its `exports` map.
 *
 * The scan used to be a `dist/**\/*.d.ts` glob, which made anything the build happened to emit count as
 * API. A module under `internal/` is absent from the exports map precisely so that it is NOT
 * importable, yet its declarations were still indexed here under the package's name. That is worse
 * than an omission: `nifra_types` would hand an agent the exact signature of a type it cannot import,
 * and the code written against it does not compile.
 *
 * So the index starts where a consumer's resolver starts, and reaches a declaration only by the route a
 * consumer could: entry point, then re-exports and the imports those re-exports name. A type declared
 * in a module nothing publicly exports from is unreachable for a consumer and unlisted here.
 */
function publishedDts(dir: string): string[] {
  const manifest = JSON.parse(read(`${dir}/package.json`)) as { exports?: unknown }
  const declared = new Set<string>()
  declaredEntries(manifest.exports, declared)
  return [...declared]
    .map((entry) => `${dir}/${entry.replace(/^\.\//, "")}`)
    .filter((file) => existsSync(file))
}

const types: TypeEntry[] = []
const typeSeen = new Set<string>()
let typedPkgs = 0
for (const p of pkgs) {
  const dts = publishedDts(p.dir)
  if (dts.length === 0) continue
  typedPkgs += 1
  for (const f of dts) extractTypesFromDts(p.name, f, typeSeen, types)
}
types.sort((a, b) => a.name.localeCompare(b.name) || a.package.localeCompare(b.package))

// ---- assemble llms.txt -------------------------------------------------------------------------

const llms = [
  "# nifra",
  "",
  `> ${SUMMARY}`,
  "",
  "For an LLM implementing with nifra with no prior training data, read **[llms-full.txt](/llms-full.txt)** — it inlines every doc page, the package READMEs, and the complete export index in one file.",
  "",
  "## Docs",
  "",
  ...docs.map(
    (d) => `- [${d.title.replace(/^nifra\s*[—-]\s*/, "")}](${d.route}): ${d.description}`,
  ),
  "",
  "## Packages",
  "",
  ...pkgs.map((p) => `- \`${p.name}\` — ${p.description}`),
  "",
].join("\n")
/**
 * `--check` verifies the committed copies match what this run would write, instead of writing.
 *
 * `api-reference.md` and the LLM.md cards have had that gate since they landed; these four did not, so
 * they were only as fresh as whoever last remembered to run `gen:llms`. They drifted, and the drift was
 * not cosmetic - `types.json` is what the `nifra_types` MCP tool answers from, so a stale copy hands an
 * agent a signature the code no longer has.
 */
const CHECK = process.argv.includes("--check")
const stale: string[] = []

function emit(path: string, contents: string): void {
  if (!CHECK) {
    writeFileSync(path, contents)
    return
  }
  const current = existsSync(path) ? readFileSync(path, "utf8") : undefined
  if (current !== contents) stale.push(path.replace(`${ROOT}/`, ""))
}

emit(`${ROOT}/llms.txt`, llms)

// ---- assemble llms-full.txt --------------------------------------------------------------------

const parts: string[] = [
  `<SYSTEM>${SYSTEM}</SYSTEM>`,
  "",
  "# nifra — full developer documentation",
  "",
  SUMMARY,
  "",
  CONVENTIONS,
  "",
  "---",
  "",
  "# Guides",
  "",
  "_Extracted from the docs at nifra.dev/docs._",
]
for (const d of docs) {
  parts.push(
    "",
    `## ${d.title.replace(/^nifra\s*[—-]\s*/, "")}`,
    "",
    `> ${d.description}`,
    "",
    d.markdown,
  )
}
parts.push("", "---", "", "# Package reference (READMEs)", "")
for (const p of pkgs) {
  const readme = `${p.dir}/README.md`
  if (!existsSync(readme)) continue
  // Demote the README's own H1 so the package name is a consistent H2 under this section.
  const body = read(readme).replace(/^#\s+/, "## ")
  parts.push("", body.trim(), "")
}
parts.push(
  "",
  "---",
  "",
  "# Complete export index (generated from each package's src/index.ts)",
  "",
)
for (const p of pkgs) {
  const index = `${p.dir}/src/index.ts`
  if (!existsSync(index)) continue
  const names = exportsOf(read(index))
  if (names.length === 0) continue
  parts.push("", `## ${p.name}`, "", names.map((n) => `\`${n}\``).join(", "))
}
const llmsFull = `${parts
  .join("\n")
  .replace(/\n{3,}/g, "\n\n")
  .trim()}\n`
emit(`${ROOT}/llms-full.txt`, llmsFull)
// Dual-write into @nifrajs/cli: the `nifra_docs` MCP tool searches this copy, and shipping it inside
// the package means published installs have the corpus without a network fetch. Same generator,
// same run — the two copies cannot drift from each other.
if (!CHECK) mkdirSync(`${ROOT}/packages/cli/docs`, { recursive: true })
emit(`${ROOT}/packages/cli/docs/llms-full.txt`, llmsFull)

// Verified-example corpus for the `nifra_example` MCP tool: the same checkable snippets `check:docs`
// typechecks against the live API, shipped inside @nifrajs/cli so an agent gets a guaranteed-compiling
// example without a network fetch. Same generator run → cannot drift from the docs or the check.
examples.sort((a, b) => a.slug.localeCompare(b.slug) || a.name.localeCompare(b.name))
emit(`${ROOT}/packages/cli/docs/examples.json`, `${JSON.stringify(examples, null, 2)}\n`)

// Type-signature corpus for the `nifra_types` MCP tool — exact TypeScript per exported symbol, shipped
// inside @nifrajs/cli so an agent gets the literal declaration without a network fetch or reading .d.ts.
emit(`${ROOT}/packages/cli/docs/types.json`, `${JSON.stringify(types, null, 2)}\n`)

if (CHECK) {
  if (stale.length > 0) {
    console.error(
      `✗ stale — run \`bun run gen:llms\` and commit the result:\n${stale.map((f) => `    ${f}`).join("\n")}`,
    )
    process.exit(1)
  }
  console.log(`✓ llms.txt, llms-full.txt, examples.json and types.json are up to date`)
} else {
  console.log(
    `Generated llms.txt (${docs.length} doc links, ${pkgs.length} packages) + llms-full.txt + examples.json (${examples.length} verified) + types.json (${types.length} types from ${typedPkgs} built packages) from source.`,
  )
}
