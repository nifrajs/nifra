import { join } from "node:path"
import { type Diagnostic, diagnostic } from "../diagnostics.ts"
import type { CheckRule, RuleContext } from "./index.ts"
import { scanSources } from "./source-scan.ts"

/**
 * NF-C059 - a route hook that does not name the page it renders in. `useSearch("/reports")` and
 * `useParams("/users/:id")` take their types from the route they name, so naming another route types a
 * page with the wrong search or params and `tsc` cannot tell: both patterns exist. In a page file
 * the pattern must be one of the page's own; a call without a literal pattern is left alone (a
 * component shared by several pages names its own route).
 */

const TEST_DIR = /(?:^|\/)(?:tests?|__tests__)\//

/** The URL patterns each page file of the app serves, by path relative to the app root. */
async function pagePatterns(ctx: RuleContext): Promise<ReadonlyMap<string, readonly string[]>> {
  const routesDir = join(ctx.root, "routes")
  const found = new Map<string, string[]>()
  try {
    const { discoverRoutes } = await import("@nifrajs/web/fs")
    for (const route of discoverRoutes(routesDir).routes) {
      const key = `routes/${route.file}`
      found.set(key, [...(found.get(key) ?? []), route.pattern])
    }
  } catch {
    return new Map()
  }
  return found
}

function wrongRoute(file: string, line: number, message: string, evidence: string): Diagnostic {
  return diagnostic({
    code: "NF-C059",
    severity: "warn",
    file,
    line,
    message,
    evidence: [evidence],
    verify: "nifra check",
  })
}

export const routeHookRule: CheckRule = {
  code: "NF-C059",
  title: "Route hook names another route than its page's",
  async scan(ctx) {
    const pages = await pagePatterns(ctx)
    if (pages.size === 0) return []
    return scanSources(ctx, {
      expectation: ["NF-C059", "route-hook"],
      components: true,
      mayMatch: (text) => text.includes("useSearch") || text.includes("useParams"),
      find: (facts, tree) => {
        const own = pages.get(tree.fileName)
        if (own === undefined) return []
        return facts.routeHookCalls(tree).flatMap((call) => {
          if (call.pattern === undefined || own.includes(call.pattern)) return []
          return [
            {
              position: call.position,
              report: (line: number, note?: string) =>
                wrongRoute(
                  tree.fileName,
                  line,
                  `${call.hook}("${call.pattern}") in a page that serves ${own.map((pattern) => `"${pattern}"`).join(" and ")}.${note === undefined ? "" : ` ${note}`}`,
                  `Name the page's own route: ${call.hook}("${own[own.length - 1]}"). A component shared by several pages keeps the pattern of the page it renders in, and a pattern kept on purpose takes \`// nifra-expect NF-C059: <reason>\` above the call.`,
                ),
            },
          ]
        })
      },
    })
  },
}

/**
 * NF-C060 - a value cast to `Href`. An `Href` is what `href()` and `rawHref()` return, the two places a
 * link is checked against the app's routes; an assertion to `Href` skips both, so a dead or hostile path compiles. A
 * path built elsewhere goes through `rawHref(path)`, which checks it at run time.
 */
export const hrefCastRule: CheckRule = {
  code: "NF-C060",
  title: "Value cast to Href",
  async scan(ctx) {
    return scanSources(ctx, {
      expectation: ["NF-C060", "href-cast"],
      components: true,
      mayMatch: (text) => text.includes("Href"),
      find: (facts, tree) =>
        TEST_DIR.test(tree.fileName)
          ? []
          : facts.hrefCasts(tree).map((cast) => ({
              position: cast.position,
              report: (line: number, note?: string) =>
                diagnostic({
                  code: "NF-C060",
                  severity: "warn",
                  file: tree.fileName,
                  line,
                  message: `A value is cast to Href, so the link is not checked against the app's routes.${note === undefined ? "" : ` ${note}`}`,
                  evidence: [
                    "Build the link with `href({ to, params, search })`, or pass a path built elsewhere through `rawHref(path)`, which checks it at run time. A cast kept on purpose takes `// nifra-expect NF-C060: <reason>` above it.",
                  ],
                  verify: "nifra check",
                }),
            })),
    })
  },
}

export const routeHookRules = Object.freeze([routeHookRule, hrefCastRule])
