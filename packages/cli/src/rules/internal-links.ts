import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Glob } from "bun"
import { IGNORED } from "../check-scan.ts"
import { type Diagnostic, diagnostic } from "../diagnostics.ts"
import { ANCHOR_HOLE } from "../internal/source-facts.ts"
import type { CheckRule, RuleContext } from "./index.ts"
import { scanSources } from "./source-scan.ts"

/**
 * NF-C057 and NF-C058 - an `<a href="/path">` written as a string. `href()` checks a link against the
 * app's routes, so a renamed or removed page is a compile error; a path string is invisible to the types.
 * The two codes split what the route table can tell apart, so each takes its own severity:
 *
 * - NF-C057 (warn): the path matches no page, no backend route and no file: the link is a 404.
 * - NF-C058 (info): the path is a page of the app, so it works today but nothing keeps it working.
 *
 * A template literal (`/users/${id}`) is judged by its shape only, and never reported as dead: the
 * route it builds may live outside the file routes.
 */

const TEST_DIR = /(?:^|\/)(?:tests?|__tests__)\//
const FILE_EXTENSION = /\.[A-Za-z0-9]{1,8}$/
// One attribute of a tag, matched where the previous one ended (sticky), so a tag is read in one pass:
// `href="/x"`, `href='/x'`, `href={"/x"}` or `` href={`/x`} `` (Svelte), and Vue's `:href="'/x'"`. Any
// other `{...}` value is an expression and names no path.
const ATTRIBUTE =
  /\s+([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)\s*\}|\{[^}]*\}))?/y
const BOUND_LITERAL = /^\s*(?:'([^']*)'|"([^"]*)"|`([^`$]*)`)\s*$/

interface Judged {
  readonly pattern: string
  readonly params: ReadonlyMap<string, string>
}

interface PageRoutes {
  /** The page route an anchor path resolves to, most specific first. */
  match(path: string): Judged | undefined
  /** Whether something other than a page serves `path`: a backend route or a file in `public/`. */
  servedElsewhere(path: string): boolean
  /** The static page pattern closest to `path`, when it is a typo away. */
  nearest(path: string): string | undefined
  /** Whether a backend route path the scan could not read leaves the dead-link verdict open. */
  readonly backendUnknown: boolean
}

const cache = new WeakMap<RuleContext, Promise<PageRoutes | undefined>>()

function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(
        (row[j] ?? 0) + 1,
        (next[j - 1] ?? 0) + 1,
        (row[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    row = next
  }
  return row[b.length] ?? 0
}

function pageRoutes(ctx: RuleContext): Promise<PageRoutes | undefined> {
  let loaded = cache.get(ctx)
  if (loaded === undefined) {
    loaded = loadPageRoutes(ctx)
    cache.set(ctx, loaded)
  }
  return loaded
}

async function loadPageRoutes(ctx: RuleContext): Promise<PageRoutes | undefined> {
  // The pages come from the file system, not the scanned sources: a `.vue`, `.svelte` or `.mdx` page is
  // not in the source index, and a missed page would turn its links into false 404s.
  const routesDir = join(ctx.root, "routes")
  if (!existsSync(routesDir)) return undefined
  const { discoverRoutes } = await import("@nifrajs/web/fs")
  const { compileRoutePattern, matchRoutePattern, sortRoutesBySpecificity } = await import(
    "@nifrajs/core/pattern"
  )
  let patterns: string[]
  try {
    patterns = discoverRoutes(routesDir).routes.map((route) => route.pattern)
  } catch {
    return undefined
  }
  if (patterns.length === 0) return undefined
  // `sortRoutesBySpecificity` reads the compiled pattern from `pattern`, and carries the rest along.
  const compile = (route: string) => {
    try {
      return [{ route, pattern: compileRoutePattern(route) }]
    } catch {
      return []
    }
  }
  const pageEntries = sortRoutesBySpecificity(patterns.flatMap(compile))
  const backendEntries = ctx.project.routes.flatMap((route) => compile(route.path))
  const staticPatterns = patterns.filter((pattern) => !/[:*]/.test(pattern))
  return {
    backendUnknown: ctx.project.sourceFindings.routePaths.length > 0,
    match(path) {
      for (const entry of pageEntries) {
        const found = matchRoutePattern(entry.pattern, path)
        if (found.matched)
          return {
            pattern: entry.route,
            params: new Map(Object.entries(found.params).map(([k, v]) => [k, String(v)])),
          }
      }
      return undefined
    },
    servedElsewhere(path) {
      if (backendEntries.some((entry) => matchRoutePattern(entry.pattern, path).matched))
        return true
      if (FILE_EXTENSION.test(path) || path.startsWith("/_")) return true
      try {
        return existsSync(join(ctx.root, "public", decodeURI(path)))
      } catch {
        return false
      }
    },
    nearest(path) {
      let best: { pattern: string; at: number } | undefined
      for (const pattern of staticPatterns) {
        const at = distance(path, pattern)
        if (at <= 2 && (best === undefined || at < best.at)) best = { pattern, at }
      }
      return best?.pattern
    },
  }
}

interface Verdict {
  readonly kind: "dead" | "unchecked"
  readonly shown: string
  readonly message: string
  readonly evidence: readonly string[]
}

const spell = (path: string): string => path.replaceAll(ANCHOR_HOLE, `\${…}`)

/** Judge one anchor path (a hole stands for a `${...}`), or undefined when it is not this rule's business. */
function judge(routes: PageRoutes, written: string): Verdict | undefined {
  const cut = written.search(/[?#]/)
  const path = cut < 0 ? written : written.slice(0, cut)
  const rest = cut < 0 ? "" : written.slice(cut)
  const dynamic = path.includes(ANCHOR_HOLE)
  const found = routes.match(dynamic ? path.replaceAll(ANCHOR_HOLE, "x") : path)
  const shown = spell(written)
  if (found !== undefined) {
    const hash = rest.includes("#") ? rest.slice(rest.indexOf("#") + 1) : undefined
    const query = rest.startsWith("?")
    const entries = [...found.params]
    const params =
      entries.length === 0
        ? ""
        : `, params: { ${entries.map(([name, value]) => `${name}: ${dynamic ? "…" : JSON.stringify(value)}`).join(", ")} }`
    const call = `href({ to: ${JSON.stringify(found.pattern)}${params}${query ? ", search: { … }" : ""}${hash !== undefined && hash !== "" && !hash.includes(ANCHOR_HOLE) ? `, hash: ${JSON.stringify(hash)}` : ""} })`
    return {
      kind: "unchecked",
      shown,
      message: `\`<a href="${shown}">\` writes a page's path by hand, so renaming or removing ${found.pattern} leaves it dead and nothing fails. Build it with \`${call}\` (\`href\` is exported by \`@nifrajs/web-<framework>/router\`), which checks the route and its params against the app.`,
      evidence: [
        `${shown} resolves to the page route ${found.pattern}`,
        "a path built elsewhere, such as a CMS link, takes `rawHref(path)`",
      ],
    }
  }
  if (dynamic || routes.backendUnknown || routes.servedElsewhere(path)) return undefined
  const near = routes.nearest(path)
  return {
    kind: "dead",
    shown,
    message: `\`<a href="${shown}">\` links to a path no page of this app serves, so following it is a 404.${near === undefined ? "" : ` Did you mean ${near}?`} Use \`href({ to })\` with a route of the app, which fails to compile for one that does not exist.`,
    evidence: [
      `${path} matches no page route, no backend route and no file in public/`,
      "a path another server answers takes `rawHref(path)`",
    ],
  }
}

const adviceFor = (code: string): string =>
  `a link kept as written, on purpose: \`// nifra-expect ${code}: <reason>\` above the attribute`

function report(
  code: string,
  severity: "warn" | "info",
  file: string,
  line: number,
  verdict: Verdict,
  note: string | undefined,
): Diagnostic {
  return diagnostic({
    code,
    severity,
    file,
    line,
    message: note === undefined ? verdict.message : `${verdict.message} ${note}`,
    evidence: [...verdict.evidence, adviceFor(code)],
    verify: "nifra check",
  })
}

/** The `href` value of every `<a>` in a Vue or Svelte template that is a string literal, with its offset. */
function templateHrefs(text: string): Array<{ readonly at: number; readonly value: string }> {
  const found: Array<{ at: number; value: string }> = []
  for (const open of text.matchAll(/<a(?=[\s/>])/g)) {
    ATTRIBUTE.lastIndex = open.index + 2
    for (let match = ATTRIBUTE.exec(text); match !== null; match = ATTRIBUTE.exec(text)) {
      const [whole, name, doubled, single, braceDouble, braceSingle, braceTemplate] = match
      if (name !== "href" && name !== ":href" && name !== "v-bind:href") continue
      const raw = doubled ?? single
      const value =
        name === "href"
          ? (raw ?? braceDouble ?? braceSingle ?? braceTemplate)
          : raw
              ?.match(BOUND_LITERAL)
              ?.slice(1)
              .find((part) => part !== undefined)
      if (value !== undefined)
        found.push({ at: ATTRIBUTE.lastIndex - whole.length + whole.indexOf(name), value })
    }
  }
  return found
}

async function templateFindings(
  ctx: RuleContext,
  routes: PageRoutes,
  kind: Verdict["kind"],
  code: string,
  severity: "warn" | "info",
): Promise<Diagnostic[]> {
  const findings: Diagnostic[] = []
  const files: string[] = []
  for await (const file of new Glob("**/*.{vue,svelte}").scan({ cwd: ctx.root, dot: false }))
    if (!IGNORED.test(file) && !TEST_DIR.test(file)) files.push(file)
  for (const file of files.sort()) {
    // The source index holds only a component's script blocks; the links are in its template.
    const text = readFileSync(join(ctx.root, file), "utf8")
    if (!text.includes("href")) continue
    for (const { at, value } of templateHrefs(text)) {
      if (!value.startsWith("/") || value.startsWith("//")) continue
      // A Svelte `{expression}` inside the value is a hole.
      const verdict = judge(routes, value.replace(/\$?\{[^}]*\}/g, ANCHOR_HOLE))
      if (verdict?.kind !== kind) continue
      findings.push(
        report(code, severity, file, text.slice(0, at).split("\n").length, verdict, undefined),
      )
    }
  }
  return findings
}

function internalLinkRule(
  code: string,
  title: string,
  kind: Verdict["kind"],
  severity: "warn" | "info",
): CheckRule {
  return {
    code,
    title,
    async scan(ctx) {
      const routes = await pageRoutes(ctx)
      if (routes === undefined) return []
      const scripts = await scanSources(ctx, {
        expectation: [code, "internal-link"],
        mayMatch: (text) => text.includes("<a") && text.includes("href"),
        find: (facts, tree) =>
          TEST_DIR.test(tree.fileName)
            ? []
            : facts.internalAnchors(tree).flatMap((anchor) => {
                const verdict = judge(routes, anchor.path)
                if (verdict?.kind !== kind) return []
                return [
                  {
                    position: anchor.position,
                    report: (line: number, note?: string) =>
                      report(code, severity, tree.fileName, line, verdict, note),
                  },
                ]
              }),
      })
      return [...scripts, ...(await templateFindings(ctx, routes, kind, code, severity))]
    },
  }
}

export const deadInternalLinkRule = internalLinkRule(
  "NF-C057",
  "Internal link to a path no page serves",
  "dead",
  "warn",
)

export const uncheckedInternalLinkRule = internalLinkRule(
  "NF-C058",
  "Internal link written as a path string",
  "unchecked",
  "info",
)

export const internalLinkRules = Object.freeze([deadInternalLinkRule, uncheckedInternalLinkRule])
