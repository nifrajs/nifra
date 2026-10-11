/**
 * `nifra routes --hooks`: which hooks run for each route and for each prefix's unmatched paths, and the
 * diff between two such reports (`--since <file>`, and `nifra upgrade`, which captures one before it
 * writes). The report itself is `reflectHooks` from `@nifrajs/core/reflection`.
 */
import type { ReflectedHook, ReflectedHookReport } from "@nifrajs/core/reflection"

/** Where `nifra upgrade --write` keeps the report it captured before editing anything. */
export const HOOKS_BEFORE_UPGRADE_FILE = ".nifra/hooks-before-upgrade.json"

export async function collectHookReport(backend: unknown): Promise<ReflectedHookReport> {
  const { reflectHooks } = await import("@nifrajs/core/reflection")
  return reflectHooks(backend)
}

const entryText = (hook: ReflectedHook): string =>
  `${hook.kind} ${hook.name}${hook.headers === undefined ? "" : ` [${hook.headers.join(", ")}]`} (${hook.site})`

/** One line per hook, keyed by `METHOD /path` for routes and `unmatched /prefix` for the rest. */
export function hookReportTargets(report: ReflectedHookReport): Map<string, readonly string[]> {
  const targets = new Map<string, readonly string[]>()
  for (const route of report.routes) {
    targets.set(`${route.method} ${route.path}`, route.hooks.map(entryText))
  }
  for (const entry of report.unmatched) {
    targets.set(`unmatched ${entry.prefix}`, entry.hooks.map(entryText))
  }
  return targets
}

export function renderHookReport(report: ReflectedHookReport): string {
  const targets = hookReportTargets(report)
  if (targets.size === 0) return "no backend routes to report hooks for"
  const lines: string[] = []
  for (const [target, hooks] of targets) {
    lines.push(target)
    if (hooks.length === 0) lines.push("  (no hooks)")
    for (const hook of hooks) lines.push(`  ${hook}`)
  }
  if (!report.complete) {
    lines.push(
      "",
      "Some hooks have no recorded origin (site `unknown`): origins are recorded only outside production builds.",
    )
  }
  return lines.join("\n")
}

export interface HookReportChange {
  readonly target: string
  readonly added: readonly string[]
  readonly removed: readonly string[]
}

/** What runs differently: per route or unmatched prefix, the hooks it gained and lost. */
export function diffHookReports(
  before: ReflectedHookReport,
  after: ReflectedHookReport,
): readonly HookReportChange[] {
  const old = hookReportTargets(before)
  const now = hookReportTargets(after)
  const changes: HookReportChange[] = []
  const minus = (from: readonly string[], take: readonly string[]): string[] => {
    const left = [...take]
    return from.filter((entry) => {
      const index = left.indexOf(entry)
      if (index === -1) return true
      left.splice(index, 1)
      return false
    })
  }
  const targets = [...new Set([...old.keys(), ...now.keys()])].sort()
  for (const target of targets) {
    const was = old.get(target) ?? []
    const is = now.get(target) ?? []
    const added = minus(is, was)
    const removed = minus(was, is)
    if (added.length > 0 || removed.length > 0) changes.push({ target, added, removed })
  }
  return changes
}

export function renderHookDiff(changes: readonly HookReportChange[]): string {
  if (changes.length === 0) return "hook scope unchanged"
  const lines: string[] = []
  for (const change of changes) {
    lines.push(change.target)
    for (const entry of change.added) lines.push(`  + ${entry}`)
    for (const entry of change.removed) lines.push(`  - ${entry}`)
  }
  return lines.join("\n")
}

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined

const hooksValid = (row: unknown): boolean => {
  const hooks = field(row, "hooks")
  return (
    Array.isArray(hooks) &&
    hooks.every(
      (hook) =>
        typeof field(hook, "kind") === "string" &&
        typeof field(hook, "name") === "string" &&
        typeof field(hook, "site") === "string",
    )
  )
}

function isHookReport(value: unknown): value is ReflectedHookReport {
  const routes = field(value, "routes")
  const unmatched = field(value, "unmatched")
  return (
    typeof field(value, "complete") === "boolean" &&
    Array.isArray(routes) &&
    Array.isArray(unmatched) &&
    routes.every(
      (row) =>
        typeof field(row, "method") === "string" &&
        typeof field(row, "path") === "string" &&
        hooksValid(row),
    ) &&
    unmatched.every((row) => typeof field(row, "prefix") === "string" && hooksValid(row))
  )
}

/** A saved report, parsed; `undefined` when the text is not one. */
export function parseHookReport(text: string): ReflectedHookReport | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return isHookReport(value) ? value : undefined
  } catch {
    return undefined
  }
}
