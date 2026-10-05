/**
 * `nifra i18n check [entry]` - runs `checkCatalogs()` from `@nifrajs/i18n/check` over an app's locale
 * registry and catalogs. Unlike `nifra check`, this IMPORTS app code: the entry module, which exports
 * `locales` (from `defineLocales`) and `catalogs` (by locale key: a catalog, or a function returning
 * one or a promise of one, such as `() => import("./messages/fr.json")`), plus an optional `ignore`.
 * The default entry is the first of {@link DEFAULT_ENTRIES} that exists.
 */
import { existsSync } from "node:fs"
import { relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { MessageTree } from "@nifrajs/i18n"
import type { CatalogCheckOptions, CatalogCheckResult, CatalogFinding } from "@nifrajs/i18n/check"

export const DEFAULT_ENTRIES = [
  "shared/i18n.ts",
  "i18n.ts",
  "lib/i18n.ts",
  "src/i18n.ts",
  "src/lib/i18n.ts",
  "app/i18n.ts",
] as const

export interface I18nCheckOutput {
  /** The entry module, relative to the project directory. */
  readonly entry: string
  readonly result: CatalogCheckResult
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object"

/** A loaded module's default export when the value is a module namespace (`import("./fr.json")`). */
const unwrapModule = (value: unknown): unknown =>
  isObject(value) && Object.prototype.toString.call(value) === "[object Module]"
    ? value.default
    : value

const isRegistry = (value: unknown): value is CatalogCheckOptions["locales"] =>
  isObject(value) &&
  typeof value.default === "string" &&
  Array.isArray(value.all) &&
  typeof value.get === "function" &&
  typeof value.chain === "function"

function resolveEntry(cwd: string, entry: string | undefined): string {
  if (entry !== undefined) {
    const path = resolve(cwd, entry)
    if (!existsSync(path)) throw new Error(`i18n check: ${entry} does not exist`)
    return path
  }
  for (const candidate of DEFAULT_ENTRIES) {
    const path = resolve(cwd, candidate)
    if (existsSync(path)) return path
  }
  throw new Error(
    `i18n check: no entry module found (looked for ${DEFAULT_ENTRIES.join(", ")}). Pass one: nifra i18n check <entry>, a module exporting \`locales\` and \`catalogs\`.`,
  )
}

/** Import the entry, load every catalog it names, and check them. */
export async function runI18nCheck(
  cwd: string,
  options: { readonly entry?: string | undefined } = {},
): Promise<I18nCheckOutput> {
  const path = resolveEntry(cwd, options.entry)
  const mod = (await import(pathToFileURL(path).href)) as Record<string, unknown>
  const source = isObject(mod.default) && mod.locales === undefined ? mod.default : mod
  const { locales, catalogs, ignore } = source
  const entry = relative(cwd, path).replaceAll("\\", "/") || path
  if (!isRegistry(locales)) {
    throw new Error(
      `i18n check: ${entry} must export \`locales\`, the registry defineLocales() returns`,
    )
  }
  if (!isObject(catalogs)) {
    throw new Error(
      `i18n check: ${entry} must export \`catalogs\`, an object of catalogs by locale key`,
    )
  }
  if (ignore !== undefined && !isObject(ignore)) {
    throw new Error(`i18n check: \`ignore\` in ${entry} must be an object of key patterns by check`)
  }
  const loaded: Record<string, MessageTree | undefined> = {}
  for (const key of Object.keys(catalogs)) {
    let value = catalogs[key]
    if (typeof value === "function") value = (value as () => unknown)()
    loaded[key] = unwrapModule(await value) as MessageTree | undefined
  }
  // Loaded on use: the command catalog imports this module on every CLI start.
  const { checkCatalogs } = await import("@nifrajs/i18n/check")
  return {
    entry,
    result: checkCatalogs({
      locales,
      catalogs: loaded,
      ignore: ignore as CatalogCheckOptions["ignore"],
    }),
  }
}

const MARK = { error: "✖", warning: "⚠", info: "•" } as const
// Per-key findings that are lists rather than problems one by one: grouped per locale in the text.
const GROUPED = new Set(["missing-key", "unused-key", "untranslated"])
const SHOWN_KEYS = 6

// Catalog keys and text reach the terminal: control and bidi-override characters print as escapes, so
// a key can neither drive the terminal nor reorder what the line appears to say.
const unprintable = (code: number): boolean =>
  code <= 0x1f ||
  (code >= 0x7f && code <= 0x9f) ||
  code === 0x200e ||
  code === 0x200f ||
  (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2066 && code <= 0x2069)
const printable = (line: string): string => {
  let out = ""
  for (const char of line) {
    const code = char.codePointAt(0) ?? 0
    out += unprintable(code) ? `\\u${code.toString(16).padStart(4, "0")}` : char
  }
  return out
}

const percent = (share: number): string => `${(share * 100).toFixed(share === 1 ? 0 : 1)}%`

/** The human report: a coverage table, then findings, grouped where they are key lists. */
export function renderI18nCheck(out: I18nCheckOutput): readonly string[] {
  const { result } = out
  const lines = [`nifra i18n check - ${out.entry}`, ""]
  const width = Math.max(6, ...result.coverage.map((row) => row.locale.length))
  for (const row of result.coverage) {
    const label = row.default ? "default" : row.draft ? "draft" : ""
    const counts = row.default
      ? `${row.total} messages`
      : `${row.translated}/${row.total} (${percent(row.coverage)})${row.own === row.translated ? "" : `, ${row.own} own`}`
    lines.push(`  ${row.locale.padEnd(width)}  ${label.padEnd(7)}  ${counts}`)
  }
  if (result.coverage.length > 0) lines.push("")

  const groups = new Map<string, CatalogFinding[]>()
  for (const finding of result.findings) {
    if (!GROUPED.has(finding.code) || finding.key === undefined) {
      lines.push(`${MARK[finding.severity]} ${finding.locale}  ${finding.code}: ${finding.message}`)
      continue
    }
    const id = `${finding.severity}\u0000${finding.locale}\u0000${finding.code}`
    const group = groups.get(id)
    if (group === undefined) groups.set(id, [finding])
    else group.push(finding)
  }
  for (const group of groups.values()) {
    const first = group[0] as CatalogFinding
    const keys = group.map((finding) => finding.key as string)
    const shown = keys.slice(0, SHOWN_KEYS).join(", ")
    const more = keys.length > SHOWN_KEYS ? `, +${keys.length - SHOWN_KEYS} more` : ""
    lines.push(
      `${MARK[first.severity]} ${first.locale}  ${first.code} (${keys.length}): ${shown}${more}`,
    )
  }

  const count = (severity: CatalogFinding["severity"]): number =>
    result.findings.filter((finding) => finding.severity === severity).length
  const errors = count("error")
  const warnings = count("warning")
  if (result.findings.length > 0) lines.push("")
  lines.push(
    errors === 0 && warnings === 0
      ? "✓ catalogs are complete and consistent"
      : `${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}${errors === 0 ? " - pass --strict to fail on warnings" : ""}`,
  )
  return lines.map(printable)
}

/** Errors fail the run; with `strict`, warnings do too. Info never does. */
export function i18nCheckPassed(out: I18nCheckOutput, strict: boolean): boolean {
  return out.result.findings.every(
    (finding) => finding.severity === "info" || (finding.severity === "warning" && !strict),
  )
}
