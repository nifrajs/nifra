/**
 * Error-code coverage gate. Every static `throw new X("message")` in a framework package is run
 * through the dev diagnostic catalog as the framework's own error. A message the catalog cannot place
 * under a stable code is "uncoded"; each package's uncoded count may only go down. A new throw whose
 * message no catalog entry recognises fails here, so it gets a code (or a message a family already
 * covers) in the change that adds it. `--update` lowers the recorded counts after a cleanup.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"
import { classify } from "../packages/web/src/diagnostic-catalog.ts"

const ROOT = join(import.meta.dir, "..", "packages")
const BASELINE = join(import.meta.dir, "error-code-baseline.json")

/** Developer tooling, agent runtimes and test harnesses: their errors are not framework errors an app meets. */
const TOOLING = new Set([
  "a2a",
  "acp",
  "ag-ui",
  "agent",
  "agent-app",
  "agent-protocol",
  "agent-review",
  "agent-telemetry",
  "cli",
  "coding-agent",
  "create-nifra",
  "devtools",
  "e2e",
  "mcp",
  "mcp-db",
  "mock",
  "pi",
  "prompt",
  "runner",
  "skills",
  "testing",
  "ts-plugin",
  "webmcp",
])

const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(path)
  }
  return out
}

const staticText = (node: ts.Expression): string | undefined => {
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isTemplateExpression(node))
    return node.head.text + node.templateSpans.map((s) => `…${s.literal.text}`).join("")
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticText(node.left)
    const right = staticText(node.right)
    return left === undefined && right === undefined ? undefined : `${left ?? "…"}${right ?? "…"}`
  }
  if (ts.isParenthesizedExpression(node)) return staticText(node.expression)
  return undefined
}

/**
 * Throws the catalog has nothing to say about: the platform's own abort signal, a sentinel the
 * import.meta.glob reader or the server-component pipeline reader throws and catches itself (it surfaces as a classified build error), and a
 * message built only from interpolated values, which has no static text to match.
 */
function notAFrameworkError(name: string, message: string, where: string): boolean {
  if (name === "DOMException") return true
  if (name === "SyntaxError" && where.startsWith("web/src/plugins/import-glob.ts:")) return true
  if (name === "Error" && where.startsWith("web/src/server-components/source.ts:")) return true
  return message.replace(/\[nifra[^\]]*\]|[…\s:]/g, "") === ""
}

export interface Uncoded {
  readonly pkg: string
  readonly where: string
  readonly name: string
  readonly message: string
}

/** Every framework throw site the catalog cannot place under a code, plus the total scanned. */
export function scanUncoded(): { total: number; excluded: number; uncoded: Uncoded[] } {
  const uncoded: Uncoded[] = []
  let total = 0
  let excluded = 0
  for (const pkg of readdirSync(ROOT)) {
    if (TOOLING.has(pkg)) continue
    const src = join(ROOT, pkg, "src")
    try {
      statSync(src)
    } catch {
      continue
    }
    for (const file of walk(src)) {
      const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true)
      const countExcluded = (skip: boolean): boolean => {
        if (skip) excluded++
        return skip
      }
      const visit = (node: ts.Node): void => {
        if (ts.isThrowStatement(node) && ts.isNewExpression(node.expression)) {
          const { expression, arguments: args } = node.expression
          const name = expression.getText(sf)
          // FrameworkError takes (code, message): the code is not what a reader sees, the message is.
          const text = args?.[name === "FrameworkError" ? 1 : 0]
          const body = text === undefined ? undefined : staticText(text)
          const message = body !== undefined && name === "FrameworkError" ? `[nifra] ${body}` : body
          if (message !== undefined) {
            total++
            const where = `${file.slice(ROOT.length + 1)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`
            const hit = classify(name, message, true)
            if (
              hit.code === "NIFRA_UNHANDLED" &&
              !countExcluded(notAFrameworkError(name, message, where))
            )
              uncoded.push({
                pkg,
                where,
                name,
                message,
              })
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(sf)
    }
  }
  return { total, excluded, uncoded }
}

export const countByPackage = (items: readonly Uncoded[]): Record<string, number> => {
  const counts: Record<string, number> = {}
  for (const item of items) counts[item.pkg] = (counts[item.pkg] ?? 0) + 1
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

export const readBaseline = (): Record<string, number> => {
  const parsed: unknown = JSON.parse(readFileSync(BASELINE, "utf8"))
  const recorded: Record<string, number> = {}
  if (typeof parsed === "object" && parsed !== null)
    for (const [pkg, count] of Object.entries(parsed))
      if (typeof count === "number") recorded[pkg] = count
  return recorded
}

/** Packages whose uncoded count rose above the recorded one. */
export function regressions(
  counts: Record<string, number>,
  baseline: Record<string, number>,
): string[] {
  return Object.entries(counts)
    .filter(([pkg, count]) => count > (baseline[pkg] ?? 0))
    .map(([pkg, count]) => `${pkg}: ${count} uncoded, recorded ${baseline[pkg] ?? 0}`)
}

if (import.meta.main) {
  const { total, excluded, uncoded } = scanUncoded()
  const counts = countByPackage(uncoded)
  if (process.argv.includes("--update")) {
    writeFileSync(BASELINE, `${JSON.stringify(counts, null, 2)}\n`)
    console.log(`recorded ${uncoded.length} uncoded of ${total} throw sites`)
  } else {
    const bad = regressions(counts, readBaseline())
    if (bad.length > 0) {
      console.error(
        "✗ framework throws no catalog entry recognises (add a code, or reuse a family):",
      )
      for (const line of bad) console.error(`  ${line}`)
      const over = new Set(bad.map((line) => line.split(":")[0]))
      for (const item of uncoded.filter((u) => over.has(u.pkg)).slice(-20))
        console.error(`  ${item.where}  ${item.name}  ${item.message.slice(0, 90)}`)
      process.exit(1)
    }
    console.log(
      `✓ error codes: ${total - uncoded.length - excluded} of ${total} framework throws classified, ${excluded} excluded by rule`,
    )
  }
}
