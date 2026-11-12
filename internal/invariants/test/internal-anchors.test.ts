/**
 * A plain `<a href="/x">` is invisible to the route table: a renamed or removed route leaves it pointing
 * at a page that is gone, and nothing fails. Every internal link in the site, the examples and the
 * starter templates is built with `href()` (a route of the app) or `rawHref()` (a path built elsewhere),
 * so a link to a route that does not exist is a compile error there.
 *
 * This reads the sources and fails on an `<a>` whose `href` is a string or template literal that starts
 * with exactly one `/`. `https://`, `mailto:`, `tel:`, `#hash` and `//cdn` values pass, and so does any
 * expression (`href={href({ to })}`). A link the gate cannot see through, or that is deliberately a
 * literal, is listed in ALLOWED with the reason; an entry whose link is gone fails until it is removed.
 */
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"

const ROOT = join(import.meta.dir, "..", "..", "..")

const SCOPE = [
  "site/**/*.{tsx,jsx}",
  "examples/**/*.{tsx,jsx,vue,svelte}",
  "packages/create-nifra/template-*/**/*.{tsx,jsx,vue,svelte}",
]
const SKIPPED = /(?:^|\/)(?:node_modules|\.nifra|dist|fixtures|\.tmp[^/]*)\//

/** Internal links that stay literal, by file: the count and why the types cannot help. */
const ALLOWED: Readonly<Record<string, { readonly count: number; readonly reason: string }>> = {}

/** Does this attribute value name a path of this origin? */
function isInternal(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//")
}

/** The literal `href` values of every `<a>` in a TSX/JSX source that name a path of this origin. */
export function internalAnchorsInScript(source: string, fileName: string): string[] {
  const kind = fileName.endsWith(".jsx") ? ts.ScriptKind.JSX : ts.ScriptKind.TSX
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind)
  const found: string[] = []
  const literalOf = (node: ts.Expression): string | undefined => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
    if (ts.isTemplateExpression(node)) return node.head.text
    return undefined
  }
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (ts.isIdentifier(node.tagName) && node.tagName.text === "a") {
        for (const attribute of node.attributes.properties) {
          if (!ts.isJsxAttribute(attribute) || attribute.name.getText(file) !== "href") continue
          const init = attribute.initializer
          if (init === undefined) continue
          const value = ts.isStringLiteral(init)
            ? init.text
            : ts.isJsxExpression(init) && init.expression !== undefined
              ? literalOf(init.expression)
              : undefined
          if (value !== undefined && isInternal(value)) found.push(value)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

const TEMPLATE_ANCHOR =
  /<a\b[^>]*?\s(?::|v-bind:)?href\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)\s*\})/gs

/** The same for a Vue or Svelte template: a static `href`, a bound string literal, or a `{"/x"}`. */
export function internalAnchorsInTemplate(source: string): string[] {
  const found: string[] = []
  for (const match of source.matchAll(TEMPLATE_ANCHOR)) {
    const [whole, doubled, single, braceDouble, braceSingle, braceTemplate] = match
    const bound = /\s(?::|v-bind:)href\s*=/.test(whole ?? "")
    // A bound attribute holds an expression: only a quoted literal inside it names a path.
    const raw = doubled ?? single
    const literal = bound
      ? raw
          ?.match(/^\s*(?:'([^']*)'|"([^"]*)"|`([^`$]*)`)\s*$/)
          ?.slice(1)
          .find((v) => v !== undefined)
      : (raw ?? braceDouble ?? braceSingle ?? braceTemplate)
    if (literal !== undefined && isInternal(literal)) found.push(literal)
  }
  return found
}

function scan(): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const glob of SCOPE) {
    for (const file of new Bun.Glob(glob).scanSync({ cwd: ROOT })) {
      if (SKIPPED.test(file) || out.has(file)) continue
      const source = readFileSync(join(ROOT, file), "utf8")
      const links = /\.(?:tsx|jsx)$/.test(file)
        ? internalAnchorsInScript(source, file)
        : internalAnchorsInTemplate(source)
      if (links.length > 0) out.set(file, links)
    }
  }
  return out
}

test("every internal link is built with href() or rawHref(), not written as a literal path", () => {
  const found = scan()
  const unexpected = [...found]
    .filter(([file, links]) => ALLOWED[file]?.count !== links.length)
    .map(
      ([file, links]) =>
        `${file}: ${links.length} (allowed ${ALLOWED[file]?.count ?? 0}) ${links.slice(0, 3).join(" ")}`,
    )
  const stale = Object.keys(ALLOWED).filter((file) => !found.has(file))
  expect({ unexpected: unexpected.sort(), stale }).toEqual({ unexpected: [], stale: [] })
})

test("the gate sees a literal and a template-literal internal anchor, and passes everything else", () => {
  const tsx = (anchors: string): string[] =>
    internalAnchorsInScript(`export default () => (<nav>${anchors}</nav>)`, "page.tsx")
  expect(tsx('<a href="/docs">Docs</a>')).toEqual(["/docs"])
  expect(tsx("<a href='/docs'>Docs</a>")).toEqual(["/docs"])
  expect(tsx('<a href={"/docs"}>Docs</a>')).toEqual(["/docs"])
  expect(tsx("<a href={`/docs`}>Docs</a>")).toEqual(["/docs"])
  expect(tsx("<a href={`/users/${id}`}>User</a>")).toEqual(["/users/"])
  expect(tsx('<a class="x" data-a="b" href="/docs#top">Docs</a>')).toEqual(["/docs#top"])
  expect(tsx('<a href="/docs"/>')).toEqual(["/docs"])
  // External, non-path and built values pass.
  expect(tsx('<a href="https://example.com/">x</a>')).toEqual([])
  expect(tsx('<a href="//cdn.example.com/x">x</a>')).toEqual([])
  expect(tsx('<a href="mailto:a@b.c">x</a>')).toEqual([])
  expect(tsx('<a href="tel:+1">x</a>')).toEqual([])
  expect(tsx('<a href="#top">x</a>')).toEqual([])
  expect(tsx('<a href={href({ to: "/docs" })}>x</a>')).toEqual([])
  expect(tsx("<a href={url}>x</a>")).toEqual([])
  expect(tsx("<a href={`${base}/docs`}>x</a>")).toEqual([])
  // Only an <a> is read.
  expect(tsx('<Link to="/docs">x</Link>')).toEqual([])
  expect(tsx('<link rel="canonical" href="/docs" />')).toEqual([])
  // The text of a code sample is not an anchor.
  expect(internalAnchorsInScript('const SAMPLE = `<a href="/docs">x</a>`', "page.tsx")).toEqual([])
})

test("the gate sees the same in a Vue and a Svelte template", () => {
  expect(internalAnchorsInTemplate('<a href="/docs">Docs</a>')).toEqual(["/docs"])
  expect(internalAnchorsInTemplate("<a class='n' href='/docs'>Docs</a>")).toEqual(["/docs"])
  expect(internalAnchorsInTemplate("<a :href=\"'/docs'\">Docs</a>")).toEqual(["/docs"])
  expect(internalAnchorsInTemplate('<a href={"/docs"}>Docs</a>')).toEqual(["/docs"])
  expect(internalAnchorsInTemplate("<a href={`/docs`}>Docs</a>")).toEqual(["/docs"])
  expect(internalAnchorsInTemplate('<a href="https://example.com/">x</a>')).toEqual([])
  expect(internalAnchorsInTemplate('<a href="#top">x</a>')).toEqual([])
  expect(internalAnchorsInTemplate("<a :href=\"href({ to: '/docs' })\">x</a>")).toEqual([])
  expect(internalAnchorsInTemplate("<a href={href({ to: '/docs' })}>x</a>")).toEqual([])
  expect(internalAnchorsInTemplate('<a :href="url">x</a>')).toEqual([])
})
