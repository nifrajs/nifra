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
- **Validate at the boundary.** Per-route \`body\`/\`query\`/\`params\`/\`headers\`/\`response\` is any Standard Schema (zod/valibot/arktype) or \`@nifrajs/schema\`'s \`t\`; invalid input → structured \`400\` before the handler runs.
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
  "mutations",
  "rendering",
  "hydration",
  "streaming",
  "query",
  "frameworks",
  "plugins",
  "security",
  "auth",
  "images",
  "i18n",
  "edge",
  "websockets",
  "deployment",
  "cli",
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

function extractTypesFromDts(
  pkgName: string,
  file: string,
  seen: Set<string>,
  out: TypeEntry[],
): void {
  const text = read(file)
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true)
  for (const stmt of sf.statements) {
    const exported =
      ts.canHaveModifiers(stmt) &&
      ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    if (!exported) continue
    let name: string | undefined
    let kind: TypeEntry["kind"] | undefined
    if (ts.isInterfaceDeclaration(stmt)) {
      name = stmt.name.text
      kind = "interface"
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      name = stmt.name.text
      kind = "type"
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      name = stmt.name.text
      kind = "class"
    } else if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      name = stmt.name.text
      kind = "function"
    } else if (ts.isEnumDeclaration(stmt)) {
      name = stmt.name.text
      kind = "enum"
    } else if (ts.isVariableStatement(stmt)) {
      const decl = stmt.declarationList.declarations[0]
      if (decl && ts.isIdentifier(decl.name)) {
        name = decl.name.text
        kind = "const"
      }
    }
    if (name === undefined || kind === undefined || seen.has(`${pkgName}:${name}`)) continue
    seen.add(`${pkgName}:${name}`)
    const doc = leadingJsDoc(text, stmt.getFullStart())
    out.push({
      name,
      kind,
      package: pkgName,
      signature: stmt.getText(sf).trim(),
      ...(doc ? { doc } : {}),
    })
  }
}

const types: TypeEntry[] = []
const typeSeen = new Set<string>()
let typedPkgs = 0
for (const p of pkgs) {
  const dts = [...new Glob("dist/**/*.d.ts").scanSync(p.dir)].filter(
    (f) => !f.endsWith(".d.ts.map"),
  )
  if (dts.length === 0) continue
  typedPkgs += 1
  for (const f of dts) extractTypesFromDts(p.name, `${p.dir}/${f}`, typeSeen, types)
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
writeFileSync(`${ROOT}/llms.txt`, llms)

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
writeFileSync(`${ROOT}/llms-full.txt`, llmsFull)
// Dual-write into @nifrajs/cli: the `nifra_docs` MCP tool searches this copy, and shipping it inside
// the package means published installs have the corpus without a network fetch. Same generator,
// same run — the two copies cannot drift from each other.
mkdirSync(`${ROOT}/packages/cli/docs`, { recursive: true })
writeFileSync(`${ROOT}/packages/cli/docs/llms-full.txt`, llmsFull)

// Verified-example corpus for the `nifra_example` MCP tool: the same checkable snippets `check:docs`
// typechecks against the live API, shipped inside @nifrajs/cli so an agent gets a guaranteed-compiling
// example without a network fetch. Same generator run → cannot drift from the docs or the check.
examples.sort((a, b) => a.slug.localeCompare(b.slug) || a.name.localeCompare(b.name))
writeFileSync(`${ROOT}/packages/cli/docs/examples.json`, `${JSON.stringify(examples, null, 2)}\n`)

// Type-signature corpus for the `nifra_types` MCP tool — exact TypeScript per exported symbol, shipped
// inside @nifrajs/cli so an agent gets the literal declaration without a network fetch or reading .d.ts.
writeFileSync(`${ROOT}/packages/cli/docs/types.json`, `${JSON.stringify(types, null, 2)}\n`)

console.log(
  `Generated llms.txt (${docs.length} doc links, ${pkgs.length} packages) + llms-full.txt + examples.json (${examples.length} verified) + types.json (${types.length} types from ${typedPkgs} built packages) from source.`,
)
