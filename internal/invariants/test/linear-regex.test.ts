/**
 * Regexes in shipped source take time linear in their input. Five fixed defects had one shape: a
 * pattern the engine retries at every start position (`/\/+$/` over a run of slashes, `/[?#].*$/` over
 * a run of `?`) or whose quantifiers trade characters (`/\s*(.+)$/`), quadratic on input an attacker
 * sizes. Every regex literal in `packages/*\/src` goes through scslre, the analysis behind
 * eslint-plugin-regexp's super-linear rules. A file may hold flagged patterns only as many as its entry
 * says, with the reason their input is bounded or trusted. A `RegExp` built at runtime cannot be
 * analysed, so a file holding one says how many and why their patterns are safe. A new pattern, one
 * more in a listed file, or an entry whose patterns are gone fails until someone reviews it.
 *
 * The analysis is not complete: `/<a(?:\s[^>]*)?\sid="x"/` passes it yet is quadratic on `<a <a <a`.
 * The input-scaling suite times the readers of request bytes for what a static check misses.
 */
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { analyse } from "scslre"
import ts from "typescript"

const ROOT = join(import.meta.dir, "..", "..", "..")
const SHIPPED = "packages/*/src/**/*.{ts,tsx,mts}"

interface Entry {
  readonly count: number
  readonly reason: string
}

const PROJECT_SOURCE = "the project's own source, read by the CLI"

/** Files holding super-linear patterns, and why the input each one sees is bounded or trusted. */
const BOUNDED: Readonly<Record<string, Entry>> = {
  "packages/cli/src/assure-hydration.ts": { count: 1, reason: "a route pattern the app declares" },
  "packages/cli/src/capabilities-tool.ts": { count: 1, reason: PROJECT_SOURCE },
  "packages/cli/src/check-scan.ts": { count: 2, reason: PROJECT_SOURCE },
  "packages/cli/src/docs-search.ts": { count: 1, reason: "one line of the bundled docs" },
  "packages/cli/src/doctor.ts": { count: 1, reason: PROJECT_SOURCE },
  "packages/cli/src/env-file.ts": { count: 1, reason: "one line of the project's own .env file" },
  "packages/cli/src/internal/reserved-segment-codemod.ts": {
    count: 1,
    reason: "one line of tsc's output for the project",
  },
  "packages/cli/src/migrate-layout.ts": {
    count: 2,
    reason: "the project's own source, and one segment of a glob from its config",
  },
  "packages/cli/src/pipeline-report.ts": { count: 5, reason: PROJECT_SOURCE },
  "packages/cli/src/port.ts": { count: 2, reason: "the source of the app being ported" },
  "packages/cli/src/rules/data-guard.ts": {
    count: 2,
    reason: "a numeric literal or an import clause from the project's source",
  },
  "packages/cli/src/rules/legacy.ts": {
    count: 1,
    reason: "one line of tsc's output for the project",
  },
  "packages/cli/src/rules/pages.ts": { count: 1, reason: PROJECT_SOURCE },
  "packages/cli/src/rules/security.ts": {
    count: 1,
    reason: "an identifier from the project's source",
  },
  "packages/cli/src/sdk.ts": { count: 1, reason: "a route path the app declares" },
  "packages/cli/src/search-terms.ts": {
    count: 1,
    reason: "a query cut to MAX_QUERY_CHARS, or a heading, name or slug of the bundled docs",
  },
  "packages/cli/src/test-tool.ts": {
    count: 5,
    reason: "the summary of the project's own test run",
  },
  "packages/cli/src/types-search.ts": {
    count: 1,
    reason: "a doc comment of the bundled types.json",
  },
  "packages/core/src/server/server.ts": {
    count: 2,
    reason: "a frame of an Error this module constructs, written by the runtime",
  },
  "packages/core/src/single-copy.ts": { count: 1, reason: "one line of the project's bunfig.toml" },
  "packages/web/src/dev-sourcemap.ts": {
    count: 2,
    reason: "one stack line the page posts to the local dev server, at most MAX_FRAMES of them",
  },
  "packages/web/src/diagnostic-prompt.ts": {
    count: 1,
    reason: "one frame of a diagnostic the local dev server captured",
  },
  "packages/web/src/internal/secret-scan.ts": {
    count: 1,
    reason: "the 16 characters before a match",
  },
  "packages/web/src/internal/server-boundary.ts": {
    count: 1,
    reason: "the app's own source, scanned at build",
  },
  "packages/web/src/plugins/css-modules.ts": {
    count: 1,
    reason: "one declaration of the app's own CSS, at build",
  },
}

const PROJECT_NAMES = "names, paths and imports of the project, run over its own source"
const BUNDLER_FILTER = "bundler filters for escaped constant module ids"

/** Files that build a `RegExp` at runtime, and why the patterns they build are linear. */
const BUILT: Readonly<Record<string, Entry>> = {
  "packages/acp/src/index.ts": { count: 1, reason: "the ANSI escape pattern, from a char code" },
  "packages/cli/src/capabilities-tool.ts": { count: 2, reason: "copies of literals checked here" },
  "packages/cli/src/check-scan.ts": { count: 6, reason: PROJECT_NAMES },
  "packages/cli/src/init-agents.ts": {
    count: 4,
    reason: "the CLI's package name and version pattern, constants",
  },
  "packages/cli/src/migrate-layout.ts": { count: 11, reason: PROJECT_NAMES },
  "packages/cli/src/output-schemas.ts": { count: 2, reason: PROJECT_NAMES },
  "packages/cli/src/pipeline-report.ts": { count: 2, reason: PROJECT_NAMES },
  "packages/cli/src/port.ts": { count: 1, reason: PROJECT_NAMES },
  "packages/cli/src/rules/comment-markers.ts": {
    count: 1,
    reason: "escaped marker names, constants",
  },
  "packages/cli/src/rules/contract-visibility.ts": { count: 1, reason: PROJECT_NAMES },
  "packages/cli/src/rules/data-guard.ts": { count: 2, reason: PROJECT_NAMES },
  "packages/cli/src/test-tool.ts": {
    count: 1,
    reason: "the ANSI escape pattern, from a char code",
  },
  "packages/cli/src/upgrade.ts": { count: 3, reason: PROJECT_NAMES },
  "packages/core/src/internal/route-assurance.ts": {
    count: 1,
    reason: "a route: escaped statics and `[^/]+` per parameter",
  },
  "packages/core/src/router/pattern.ts": {
    count: 1,
    reason:
      "a route: escaped statics, `([^/]+)` per parameter, one final `(.+)`, anchored both ends",
  },
  "packages/core/src/server/logger.ts": {
    count: 1,
    reason: "the app's own redaction pattern with the global flag",
  },
  "packages/core/src/server/response-contract-lane.ts": {
    count: 1,
    reason: "a JSON Schema `pattern` of the app's own response contract",
  },
  "packages/core/src/single-copy.ts": {
    count: 2,
    reason: "bundler filters for escaped package roots",
  },
  "packages/core/src/wire.ts": {
    count: 1,
    reason: "the RegExp node of a decoded wire value; nothing here runs it",
  },
  "packages/i18n/src/check.ts": {
    count: 4,
    reason: "Unicode script classes of the locale, and a constant tag pattern",
  },
  "packages/i18n/src/rich.ts": { count: 1, reason: "a constant tag pattern with the sticky flag" },
  "packages/mock/src/index.ts": {
    count: 1,
    reason: "a JSON Schema `pattern` of the app's own schema",
  },
  "packages/pi/src/index.ts": {
    count: 1,
    reason: "escaped secrets as alternatives, no quantifier",
  },
  "packages/web-solid/src/plugin.ts": { count: 1, reason: BUNDLER_FILTER },
  "packages/web-vue/src/index.ts": {
    count: 1,
    reason: "a teleport id over Vue's escaped markup, where every `<` opens a tag a `>` closes",
  },
  "packages/web/src/build.ts": { count: 2, reason: BUNDLER_FILTER },
  "packages/web/src/dev-ssr-graph.ts": { count: 1, reason: "the project's escaped root paths" },
  "packages/web/src/internal/dev-reserved.ts": {
    count: 1,
    reason: "a lookahead around a filter the dev server declares",
  },
  "packages/web/src/internal/output-guard.ts": {
    count: 1,
    reason: "a `patternProperties` key of the app's own schema",
  },
  "packages/web/src/internal/ppr/compile-shell.ts": { count: 3, reason: BUNDLER_FILTER },
  "packages/web/src/internal/render-document.ts": {
    count: 1,
    reason: "a class of four constant characters",
  },
  "packages/web/src/plugins/kit.ts": { count: 1, reason: BUNDLER_FILTER },
  "packages/web/src/plugins/stylex.ts": { count: 1, reason: "an escaped package name" },
  "packages/web/src/plugins/svg.ts": {
    count: 1,
    reason: "an attribute name from a constant table",
  },
  "packages/web/src/plugins/zone-guard.ts": {
    count: 3,
    reason: "constant extension and suffix alternatives, and a constant marker",
  },
  "packages/web/src/prerender.ts": { count: 1, reason: "constant names, escaped" },
  "packages/web/src/zones.ts": { count: 2, reason: "constant suffix alternatives" },
}

interface Patterns {
  readonly literals: readonly { readonly source: string; readonly flags: string }[]
  readonly built: number
}

/** The regex literals of `text`, constant `RegExp(...)` calls included, and the calls built otherwise. */
function patternsIn(file: string, text: string): Patterns {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const literals: { source: string; flags: string }[] = []
  let built = 0
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      const literal = node.getText(source)
      const end = literal.lastIndexOf("/")
      literals.push({ source: literal.slice(1, end), flags: literal.slice(end + 1) })
    } else if (
      (ts.isNewExpression(node) || ts.isCallExpression(node)) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "RegExp"
    ) {
      const [pattern, flagArg] = node.arguments ?? []
      const constant = (arg: ts.Expression | undefined): string | undefined =>
        arg !== undefined && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))
          ? arg.text
          : undefined
      const text = constant(pattern)
      const flags = flagArg === undefined ? "" : constant(flagArg)
      if (text !== undefined && flags !== undefined) literals.push({ source: text, flags })
      else built++
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { literals, built }
}

const superLinear = (source: string, flags: string): boolean =>
  analyse({ source, flags }).reports.length > 0

function scan(): { readonly flagged: Map<string, number>; readonly built: Map<string, number> } {
  const flagged = new Map<string, number>()
  const built = new Map<string, number>()
  for (const file of new Bun.Glob(SHIPPED).scanSync({ cwd: ROOT })) {
    if (file.endsWith(".d.ts") || file.includes("/fixtures/")) continue
    const found = patternsIn(file, readFileSync(join(ROOT, file), "utf8"))
    const count = found.literals.filter(({ source, flags }) => superLinear(source, flags)).length
    if (count > 0) flagged.set(file, count)
    if (found.built > 0) built.set(file, found.built)
  }
  return { flagged, built }
}

function drift(hits: Map<string, number>, allowed: Readonly<Record<string, Entry>>) {
  const unexpected = [...hits]
    .filter(([file, count]) => allowed[file]?.count !== count)
    .map(([file, count]) => `${file}: ${count} (allowed ${allowed[file]?.count ?? 0})`)
  const stale = Object.keys(allowed).filter((file) => !hits.has(file))
  return { unexpected: unexpected.sort(), stale }
}

const found = scan()

test("super-linear-regex: a regex retried at every position, or trading characters, was quadratic on attacker input", () => {
  expect(drift(found.flagged, BOUNDED)).toEqual({ unexpected: [], stale: [] })
})

test("runtime-regex: a RegExp built at runtime cannot be analysed, so each file says why it is linear", () => {
  expect(drift(found.built, BUILT)).toEqual({ unexpected: [], stale: [] })
})

test("the analysis flags every pattern behind a past fix, and passes the linear rewrites here", () => {
  const pastFixes = [
    /\/+$/,
    /-+$/,
    /[\\/]+$/,
    /[?#].*$/,
    /\((.+):(\d+):(\d+)\)\s*$/,
    /at\s+(?:async\s+)?(.+):(\d+):(\d+)\s*$/,
    /(?:\/\*\s*([^*]+?)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/g,
    /\b(from|import|require)(\s*\(?\s*)(["'])([^"'\n]+)\3/g,
  ]
  // Each rewrite matches the same strings as the pattern it replaced (`={1,2}` on base64 output).
  const rewrites = [
    /(?<!\/)\/+$/,
    /(?<!\n)\n*$/,
    /^-+|(?<!-)-+$/g,
    /={1,2}$/,
    /^bytes\s*=\s*(\S.*)$/i,
    /:has\(\s*>\s*([^)\s][^)]*)?\)/,
    /^[a-z][a-z0-9+.-]*:\/\/[^/@\s:]+:[^/@\s]+@/i,
    /^#\/\$defs\/([^/]*)((?:\/.*)?)$/,
  ]
  const verdicts = (patterns: readonly RegExp[]) =>
    patterns.map((re) => [String(re), superLinear(re.source, re.flags)] as const)
  expect(verdicts(pastFixes)).toEqual(pastFixes.map((re) => [String(re), true] as const))
  expect(verdicts(rewrites)).toEqual(rewrites.map((re) => [String(re), false] as const))
  const sample = patternsIn(
    "sample.tsx",
    'const a = path.replace(/\\/+$/, "")\nconst b = new RegExp("x+y")\nconst c = new RegExp(name, "g")\nconst d = <p title={/a/.source} />',
  )
  expect(sample).toEqual({
    literals: [
      { source: "\\/+$", flags: "" },
      { source: "x+y", flags: "" },
      { source: "a", flags: "" },
    ],
    built: 1,
  })
})
