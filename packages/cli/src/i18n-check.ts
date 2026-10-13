/**
 * `nifra i18n check [entry]` - runs `checkCatalogs()` from `@nifrajs/i18n/check` over an app's locale
 * registry and catalogs. Unlike `nifra check`, this IMPORTS app code: the entry module, which exports
 * `locales` (from `defineLocales`) and `catalogs` (by locale key: a catalog, or a function returning
 * one or a promise of one, such as `() => import("./messages/fr.json")`), plus an optional `ignore`.
 * The default entry is the first of {@link DEFAULT_ENTRIES} that exists.
 *
 * An entry may export a copy function (`defineCopy` from `@nifrajs/i18n/copy`) as well as, or instead
 * of, `catalogs`. Its tables are found in the project's source with the TypeScript AST, read without
 * running them, and checked as catalogs too: each under its id, its `file:line` or `copy.id()`'s.
 */
import { existsSync, readFileSync } from "node:fs"
import { relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { MessageTree } from "@nifrajs/i18n"
import type {
  CatalogCheckOptions,
  CatalogCheckResult,
  CatalogFinding,
  CopyTableEntry,
} from "@nifrajs/i18n/check"
import type { CopyTableSite } from "@nifrajs/i18n/extract"

export const DEFAULT_ENTRIES = [
  "shared/i18n.ts",
  "i18n.ts",
  "lib/i18n.ts",
  "src/i18n.ts",
  "src/lib/i18n.ts",
  "app/i18n.ts",
] as const

/** The copy tables a check read, when the entry exports a copy function. */
export interface CopyTablesChecked {
  /** Where the copy function is defined (`shared/i18n.ts`). */
  readonly definitions: readonly string[]
  readonly tables: number
  readonly files: number
  /** Each table's id -> its `file:line`. */
  readonly locations: Readonly<Record<string, string>>
}

export interface I18nCheckOutput {
  /** The entry module, relative to the project directory. */
  readonly entry: string
  readonly result: CatalogCheckResult
  readonly copy?: CopyTablesChecked
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object"

/** A loaded module's default export when the value is a module namespace (`import("./fr.json")`). */
const unwrapModule = (value: unknown): unknown =>
  isObject(value) && Object.prototype.toString.call(value) === "[object Module]"
    ? value.default
    : value

/** A copy function `defineCopy` returned: callable, with `pick`, `format` and its registry. */
const isCopy = (value: unknown): value is { readonly locales: unknown } =>
  typeof value === "function" &&
  "pick" in value &&
  typeof value.pick === "function" &&
  "format" in value &&
  typeof value.format === "function" &&
  "locales" in value

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

/** Import the entry, load every catalog it names, read the copy tables, and check them. */
export async function runI18nCheck(
  cwd: string,
  options: { readonly entry?: string | undefined } = {},
): Promise<I18nCheckOutput> {
  const path = resolveEntry(cwd, options.entry)
  const mod = (await import(pathToFileURL(path).href)) as Record<string, unknown>
  const source = isObject(mod.default) && mod.locales === undefined ? mod.default : mod
  const { catalogs, ignore } = source
  const entry = relative(cwd, path).replaceAll("\\", "/") || path
  const copies = Object.entries(source).filter(
    (entry): entry is [string, { readonly locales: unknown }] => isCopy(entry[1]),
  )
  const locales = source.locales ?? copies[0]?.[1].locales
  if (!isRegistry(locales)) {
    throw new Error(
      `i18n check: ${entry} must export \`locales\`, the registry defineLocales() returns`,
    )
  }
  if (!isObject(catalogs) && copies.length === 0) {
    throw new Error(
      `i18n check: ${entry} must export \`catalogs\`, an object of catalogs by locale key, or a copy function from defineCopy()`,
    )
  }
  if (ignore !== undefined && !isObject(ignore)) {
    throw new Error(`i18n check: \`ignore\` in ${entry} must be an object of key patterns by check`)
  }
  const loaded: Record<string, MessageTree | undefined> = {}
  for (const [key, entryValue] of isObject(catalogs) ? Object.entries(catalogs) : []) {
    let value = entryValue
    if (typeof value === "function") value = (value as () => unknown)()
    loaded[key] = unwrapModule(await value) as MessageTree | undefined
  }
  // Loaded on use: the command catalog imports this module on every CLI start.
  const { checkCatalogs } = await import("@nifrajs/i18n/check")
  const copy =
    copies.length === 0
      ? undefined
      : await readCopyTables(
          cwd,
          path,
          locales,
          copies.map(([name]) => name),
          loaded,
        )
  const result = checkCatalogs({
    locales,
    catalogs: copy?.catalogs ?? loaded,
    ignore: ignore as CatalogCheckOptions["ignore"],
  })
  if (copy === undefined) return { entry, result }
  const findings = [...copy.findings, ...result.findings]
  return {
    entry,
    result: { ...result, findings, ok: findings.every((finding) => finding.severity !== "error") },
    copy: copy.checked,
  }
}

/**
 * Find every table of the entry's copy functions in the project, and merge them into `loaded` as
 * catalogs. Problems with the tables themselves come back as findings.
 */
async function readCopyTables(
  cwd: string,
  entryPath: string,
  locales: CatalogCheckOptions["locales"],
  exportNames: readonly string[],
  loaded: Readonly<Record<string, MessageTree | undefined>>,
): Promise<{
  readonly catalogs: Record<string, MessageTree | undefined>
  readonly findings: readonly CatalogFinding[]
  readonly checked: CopyTablesChecked
}> {
  const [{ walkSource }, { loadProjectTypeScript }, { createCopyScanner }, { tablesToCatalogs }] =
    await Promise.all([
      import("./check-scan.ts"),
      import("./internal/typescript-import.ts"),
      import("@nifrajs/i18n/extract"),
      import("@nifrajs/i18n/check"),
    ])
  const root = resolve(cwd).replaceAll("\\", "/")
  const files = new Map<string, string>()
  await walkSource(cwd, (file, content) => files.set(`${root}/${file}`, content), { scripts: true })
  const ts = await loadProjectTypeScript(cwd)
  const findings: CatalogFinding[] = []
  const finding = (
    severity: CatalogFinding["severity"],
    code: "copy-table" | "copy-id",
    key: string | undefined,
    message: string,
  ): void => {
    const found: CatalogFinding = { severity, code, locale: locales.default, message }
    findings.push(key === undefined ? found : { ...found, key })
  }
  const checked = (
    definitions: readonly string[],
    sites: readonly CopyTableSite[],
  ): CopyTablesChecked => ({
    definitions,
    tables: sites.length,
    files: new Set(sites.map((site) => site.file)).size,
    // The first table under an id is the one checked; a later one is reported as reusing it.
    locations: Object.fromEntries(
      sites.toReversed().map((site) => [site.id, `${site.file}:${site.line}`]),
    ),
  })
  try {
    if (ts.compiler === undefined) {
      finding(
        "error",
        "copy-table",
        undefined,
        "copy tables need the project's TypeScript to be read; install typescript",
      )
      return { catalogs: { ...loaded }, findings, checked: checked([], []) }
    }
    const scanner = createCopyScanner(ts.compiler, {
      root,
      read: (file) => {
        const known = files.get(file)
        if (known !== undefined) return known
        try {
          return readFileSync(file, "utf8")
        } catch {
          return undefined
        }
      },
    })
    const entryFile = entryPath.replaceAll("\\", "/")
    const definitions = new Set<string>()
    for (const name of exportNames) {
      const ref = scanner.exportedDefinition(entryFile, name)
      if (ref === undefined) {
        finding(
          "error",
          "copy-table",
          undefined,
          `\`${name}\` in ${relative(cwd, entryPath)} does not lead to a \`defineCopy(...)\` constant, so its tables cannot be found`,
        )
        continue
      }
      definitions.add(`${ref.file}\u0000${ref.name}`)
      const unreadable = scanner.definition(ref)?.unreadable
      if (unreadable !== undefined) {
        finding(
          "warning",
          "copy-table",
          undefined,
          `${ref.file}: ${unreadable}, so a production client build keeps every locale of its tables in every page`,
        )
      }
    }
    const sites = [...files.keys()]
      .flatMap((file) => scanner.tables(file))
      .filter((site) => definitions.has(`${site.definition.file}\u0000${site.definition.name}`))
    const tables: CopyTableEntry[] = []
    const seen = new Map<string, CopyTableSite>()
    for (const site of sites) {
      const where = `${site.file}:${site.line}`
      if (site.values === undefined) {
        finding(
          "warning",
          "copy-table",
          site.id,
          `${where} is not read statically (${site.unreadable}), so it is not checked and a production client build keeps every locale of it`,
        )
        continue
      }
      const first = seen.get(site.id)
      if (first !== undefined) {
        finding(
          "error",
          "copy-id",
          site.id,
          `${where} reuses the id of ${first.file}:${first.line}`,
        )
        continue
      }
      seen.set(site.id, site)
      tables.push({ id: site.id, values: site.values })
    }
    const transposed = tablesToCatalogs(tables, locales)
    for (const id of transposed.conflicts) {
      finding("error", "copy-id", id, `${id} nests under, or over, another table's id`)
    }
    // Catalog keys and table ids share one namespace per locale.
    const catalogs: Record<string, MessageTree | undefined> = { ...loaded }
    for (const [locale, tree] of Object.entries(transposed.catalogs)) {
      const own = catalogs[locale]
      if (own === undefined) {
        catalogs[locale] = tree
        continue
      }
      const merged: MessageTree = { ...own }
      for (const [key, value] of Object.entries(tree)) {
        if (Object.hasOwn(merged, key)) {
          finding("error", "copy-id", key, `the ${locale} catalog and a copy table both use ${key}`)
          continue
        }
        merged[key] = value
      }
      catalogs[locale] = merged
    }
    return {
      catalogs,
      findings,
      checked: checked(
        [...definitions].map((key) => key.split("\u0000", 1)[0] ?? key),
        sites,
      ),
    }
  } finally {
    await ts.session?.close()
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
  const { result, copy } = out
  const lines = [`nifra i18n check - ${out.entry}`, ""]
  if (copy !== undefined) {
    lines.splice(
      1,
      0,
      `${copy.tables} copy table${copy.tables === 1 ? "" : "s"} in ${copy.files} file${copy.files === 1 ? "" : "s"} (${copy.definitions.join(", ") || "no definition found"})`,
    )
  }
  // An explicit copy.id() reads as a key; say where it is.
  const located = (key: string): string => {
    const at = copy?.locations[key]
    return at === undefined || key.startsWith(at) ? key : `${key} (${at})`
  }
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
      const at = finding.key === undefined ? undefined : copy?.locations[finding.key]
      const where = at === undefined || finding.message.includes(at) ? "" : ` (${at})`
      lines.push(
        `${MARK[finding.severity]} ${finding.locale}  ${finding.code}: ${finding.message}${where}`,
      )
      continue
    }
    const id = `${finding.severity}\u0000${finding.locale}\u0000${finding.code}`
    const group = groups.get(id)
    if (group === undefined) groups.set(id, [finding])
    else group.push(finding)
  }
  for (const group of groups.values()) {
    const first = group[0] as CatalogFinding
    const keys = group.map((finding) => located(finding.key as string))
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
