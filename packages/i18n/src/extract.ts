/**
 * `@nifrajs/i18n/extract` - reads copy tables (`@nifrajs/i18n/copy`) out of source code without running
 * it, for `nifra i18n check` and the `@nifrajs/web` client build. It finds every call of a copy function
 * that `defineCopy` defines, follows imports and re-exports to that definition, reads each table's values
 * and the registry they are typed against, and gives every table an id: the one passed to `copy.id()`,
 * or its `file:line`.
 *
 * Values are read statically: string literals, lists and blocks of them, and constants the same module
 * declares with one (`{ en: EN, hi: HI }`). A table whose values come from anything else is reported as
 * unreadable rather than guessed at. The TypeScript compiler API (5 or 6) is passed in, so this package
 * stays dependency-free.
 */
import type * as TS from "typescript"
import type { CopyValue } from "./copy.ts"
import { defineLocales, type Locales } from "./locales.ts"

const COPY_MODULE = "@nifrajs/i18n/copy"
const I18N_MODULE = "@nifrajs/i18n"
const MAX_HOPS = 8
const SCRIPT = /\.[cm]?[jt]sx?$/
const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const

/** Where the scanner reads source. Paths are absolute, `/`-separated. */
export interface CopySourceHost {
  /** The project root: result files are relative to it. */
  readonly root: string
  /** A file's text, or `undefined` when there is none. */
  read(file: string): string | undefined
  /** Resolve a bare specifier (a workspace package) the scanner's own resolution cannot: relative
   * paths and the root tsconfig's `paths` are handled already. */
  resolve?(specifier: string, from: string): string | undefined
}

/** A `defineCopy` definition: the module and binding it is declared with. */
export interface CopyDefinitionRef {
  /** Relative to the root. */
  readonly file: string
  readonly name: string
}

export interface CopyDefinition extends CopyDefinitionRef {
  readonly line: number
  /** The registry the definition's tables are typed against, read statically. */
  readonly locales?: Locales
  /** Why {@link locales} could not be read. */
  readonly unreadable?: string
}

/** One table: a call of a copy function. */
export interface CopyTableSite {
  /** The `copy.id()` id, or `file:line` (`file:line:column` when a line holds two tables). */
  readonly id: string
  readonly explicit: boolean
  /** Relative to the root. */
  readonly file: string
  readonly line: number
  readonly column: number
  /** The call's range in the module text. */
  readonly start: number
  readonly end: number
  readonly definition: CopyDefinitionRef
  /** The expression the module reaches the copy function by (`copy`, `i18n.copy`). */
  readonly callee: string
  /** The values by locale key; absent when {@link unreadable}. */
  readonly values?: Readonly<Record<string, CopyValue>>
  /** Why the values could not be read statically. */
  readonly unreadable?: string
}

export interface CopyScanner {
  /** The copy tables a module holds, in source order. */
  tables(file: string): readonly CopyTableSite[]
  /** A definition and its registry. */
  definition(ref: CopyDefinitionRef): CopyDefinition | undefined
  /** The definition a module's export names, following re-exports. */
  exportedDefinition(file: string, name: string): CopyDefinitionRef | undefined
  /**
   * The module with each table a client build can split replaced by its chunk id
   * (`copyRef("<id>")`), and the copy loaded before the first statement that holds one, or `undefined`
   * when it has none. Line breaks are kept, so the module's line numbers do not move.
   */
  rewrite(file: string): string | undefined
}

/** One locale's chunk of a client build: values by chunk id, and for each table that had no value of
 * its own, its readable id and the locale whose value it carries. */
export interface CopyChunk {
  readonly v: Readonly<Record<string, CopyValue>>
  readonly f?: Readonly<Record<string, readonly [string, string]>>
}

/** A table a client build split, with the registry its definition reads. */
export interface SplitTable {
  readonly id: string
  readonly values: Readonly<Record<string, CopyValue>>
  readonly locales: Locales
}

/**
 * The chunk each locale of a client build loads: every table's value in that locale, or, where it has
 * none, the value `locales.chain()` falls back to, so a page needs no other locale's chunk.
 */
export function copyChunks(tables: Iterable<SplitTable>): Map<string, CopyChunk> {
  const out = new Map<
    string,
    { v: Record<string, CopyValue>; f: Record<string, [string, string]> }
  >()
  const owners = new Map<string, string>()
  for (const { id, values, locales } of tables) {
    const key = copyChunkId(id)
    const owner = owners.get(key)
    if (owner === id)
      throw new Error(`[nifra/i18n] two copy tables use the id ${JSON.stringify(id)}`)
    if (owner !== undefined) {
      throw new Error(
        `[nifra/i18n] copy tables ${owner} and ${id} share chunk id ${key}; give one an explicit copy.id()`,
      )
    }
    owners.set(key, id)
    for (const locale of locales.all) {
      let chunk = out.get(locale)
      if (chunk === undefined) {
        chunk = { v: {}, f: {} }
        out.set(locale, chunk)
      }
      for (const from of locales.chain(locale)) {
        const value = values[from]
        if (value === undefined) continue
        chunk.v[key] = value
        if (from !== locale) chunk.f[key] = [id, from]
        break
      }
    }
  }
  const chunks = new Map<string, CopyChunk>()
  for (const [locale, { v, f }] of out) {
    chunks.set(locale, Object.keys(f).length === 0 ? { v } : { v, f })
  }
  return chunks
}

/** The specifier and name the rewrite imports `copyRef` as. */
const REF_IMPORT = `import { copyRef as __nifraCopyRef } from "${COPY_MODULE}";`

/** A JSON-like value the reader understands, or the reason it does not. */
type Read =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly why: string }

interface ModuleFacts {
  readonly file: string
  readonly tree: TS.SourceFile
  /** Local name -> named import. `imported` is `"default"` for a default import. */
  readonly imports: Map<string, { readonly from: string; readonly imported: string }>
  /** Local name -> specifier of a namespace import. */
  readonly namespaces: Map<string, string>
  /** Exported name -> local name. */
  readonly exports: Map<string, string>
  readonly reexports: {
    readonly from: string
    readonly imported: string
    readonly exported: string
  }[]
  readonly starExports: string[]
  /** Top-level `const` initializers, by name. */
  readonly consts: Map<string, TS.Expression>
  /** Top-level statements, by the name each `const` declares. */
  readonly statements: Map<string, TS.Statement>
}

const slash = (path: string): string => path.replaceAll("\\", "/")
const dirOf = (path: string): string => path.slice(0, Math.max(path.lastIndexOf("/"), 0)) || "/"
function joinPath(base: string, relative: string): string {
  const parts = (relative.startsWith("/") ? relative : `${base}/${relative}`).split("/")
  const out: string[] = []
  for (const part of parts) {
    if (part === "..") out.pop()
    else if (part !== "." && (part !== "" || out.length === 0)) out.push(part)
  }
  return out.join("/") || "/"
}

/**
 * A short, stable id for a table in a client build's chunks: 40 bits of FNV-1a over its readable id,
 * in base 36. The build and the chunks it writes must agree, so both call this.
 */
export function copyChunkId(id: string): string {
  let low = 0x811c9dc5
  let high = 0x01000193
  for (let i = 0; i < id.length; i++) {
    const code = id.charCodeAt(i)
    low = Math.imul(low ^ code, 0x01000193) >>> 0
    high = Math.imul(high ^ code ^ (low >>> 7), 0x01000193) >>> 0
  }
  return ((high & 0xff) * 0x100000000 + low).toString(36)
}

/**
 * Scan a project's copy tables. Modules are parsed once each, on first use.
 *
 * ```ts
 * const scanner = createCopyScanner(ts, { root, read: (file) => readFileSync(file, "utf8") })
 * for (const table of scanner.tables(`${root}/routes/index.tsx`)) console.log(table.id, table.values)
 * ```
 */
export function createCopyScanner(ts: typeof TS, host: CopySourceHost): CopyScanner {
  const root = slash(host.root).replace(/(?<!\/)\/+$/, "")
  const relative = (file: string): string =>
    file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file
  const absolute = (file: string): string =>
    file.startsWith(`${root}/`) ? file : joinPath(root, file)
  const facts = new Map<string, ModuleFacts | undefined>()
  const definitions = new Map<string, CopyDefinition | undefined>()

  const paths = tsconfigPaths(ts, root)
  const exists = (file: string): boolean => host.read(file) !== undefined
  const probe = (base: string): string | undefined => {
    if (SCRIPT.test(base) && exists(base)) return base
    // `./x.js` names `./x.ts` under TypeScript's ESM rules.
    const stem = base.replace(/\.[cm]?js$/, "")
    for (const ext of EXTENSIONS) if (exists(stem + ext)) return stem + ext
    for (const ext of EXTENSIONS) if (exists(`${base}/index${ext}`)) return `${base}/index${ext}`
    return undefined
  }
  const resolve = (specifier: string, from: string): string | undefined => {
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      return probe(joinPath(dirOf(from), specifier))
    }
    for (const [pattern, targets] of paths) {
      const star = pattern.indexOf("*")
      const matched =
        star === -1
          ? pattern === specifier
            ? ""
            : undefined
          : specifier.startsWith(pattern.slice(0, star)) &&
              specifier.endsWith(pattern.slice(star + 1))
            ? specifier.slice(star, specifier.length - (pattern.length - star - 1))
            : undefined
      if (matched === undefined) continue
      for (const target of targets) {
        // Sliced, not replace(): a `$&` or `$1` in the matched text is literal.
        const at = target.indexOf("*")
        const found = probe(
          at === -1 ? target : target.slice(0, at) + matched + target.slice(at + 1),
        )
        if (found !== undefined) return found
      }
    }
    const resolved = host.resolve?.(specifier, from)
    return resolved === undefined ? undefined : slash(resolved)
  }

  const factsOf = (file: string): ModuleFacts | undefined => {
    if (facts.has(file)) return facts.get(file)
    const text = host.read(file)
    const made = text === undefined ? undefined : readModule(ts, file, text)
    facts.set(file, made)
    return made
  }

  /** The module and local binding an export resolves to, following re-exports. */
  const declarationOf = (
    file: string,
    name: string,
    hops = 0,
  ): { readonly module: ModuleFacts; readonly local: string } | undefined => {
    const module = factsOf(file)
    if (module === undefined || hops > MAX_HOPS) return undefined
    const local = module.exports.get(name)
    if (local !== undefined) {
      const imported = module.imports.get(local)
      if (imported === undefined) return { module, local }
      const target = resolve(imported.from, file)
      return target === undefined ? undefined : declarationOf(target, imported.imported, hops + 1)
    }
    for (const reexport of module.reexports) {
      if (reexport.exported !== name) continue
      const target = resolve(reexport.from, file)
      return target === undefined ? undefined : declarationOf(target, reexport.imported, hops + 1)
    }
    for (const from of module.starExports) {
      const target = resolve(from, file)
      const found = target === undefined ? undefined : declarationOf(target, name, hops + 1)
      if (found !== undefined) return found
    }
    return undefined
  }

  /** Whether `call` is `defineCopy(...)` / `defineLocales(...)` imported from its module. */
  const callsImport = (
    module: ModuleFacts,
    call: TS.Expression,
    name: string,
    from: string,
  ): call is TS.CallExpression => {
    if (!ts.isCallExpression(call)) return false
    const callee = call.expression
    if (ts.isIdentifier(callee)) {
      const imported = module.imports.get(callee.text)
      return imported?.from === from && imported.imported === name
    }
    return (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      module.namespaces.get(callee.expression.text) === from &&
      callee.name.text === name
    )
  }

  const unwrap = (node: TS.Expression): TS.Expression => {
    let expr = node
    while (
      ts.isParenthesizedExpression(expr) ||
      ts.isAsExpression(expr) ||
      ts.isSatisfiesExpression(expr) ||
      ts.isNonNullExpression(expr) ||
      ts.isTypeAssertionExpression(expr)
    ) {
      expr = expr.expression
    }
    return expr
  }

  /** A JSON-like value written in source: literals, lists, blocks, and same-module constants. */
  const readValue = (module: ModuleFacts, node: TS.Expression, seen: Set<string>): Read => {
    const expr = unwrap(node)
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
      return { ok: true, value: expr.text }
    }
    if (ts.isNumericLiteral(expr)) return { ok: true, value: Number(expr.text) }
    if (expr.kind === ts.SyntaxKind.TrueKeyword) return { ok: true, value: true }
    if (expr.kind === ts.SyntaxKind.FalseKeyword) return { ok: true, value: false }
    if (expr.kind === ts.SyntaxKind.NullKeyword) return { ok: true, value: null }
    if (ts.isIdentifier(expr)) {
      const init = module.consts.get(expr.text)
      if (init === undefined || seen.has(expr.text)) {
        return {
          ok: false,
          why: module.imports.has(expr.text)
            ? `\`${expr.text}\` is imported; only constants this module declares are read`
            : `\`${expr.text}\` is not a constant this module declares`,
        }
      }
      return readValue(module, init, new Set(seen).add(expr.text))
    }
    if (ts.isArrayLiteralExpression(expr)) {
      const items: unknown[] = []
      for (const element of expr.elements) {
        if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) {
          return { ok: false, why: "a list with a spread or a hole" }
        }
        const item = readValue(module, element, seen)
        if (!item.ok) return item
        items.push(item.value)
      }
      return { ok: true, value: items }
    }
    if (ts.isObjectLiteralExpression(expr)) {
      const out: Record<string, unknown> = {}
      for (const property of expr.properties) {
        let key: string | undefined
        let value: Read
        if (ts.isPropertyAssignment(property)) {
          const name = property.name
          key =
            ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)
              ? name.text
              : undefined
          value = readValue(module, property.initializer, seen)
        } else if (ts.isShorthandPropertyAssignment(property)) {
          key = property.name.text
          value = readValue(module, property.name, seen)
        } else {
          return { ok: false, why: "a block with a spread, a method or an accessor" }
        }
        if (key === undefined) return { ok: false, why: "a block with a computed key" }
        if (!value.ok) return value
        out[key] = value.value
      }
      return { ok: true, value: out }
    }
    if (ts.isTemplateExpression(expr)) {
      return { ok: false, why: "a template with substitutions; a message that takes values is ICU" }
    }
    return { ok: false, why: `${ts.SyntaxKind[expr.kind] ?? "an expression"} is not data` }
  }

  /** The registry a `defineCopy(<registry>)` argument names, run through `defineLocales`. */
  const registryOf = (
    module: ModuleFacts,
    node: TS.Expression | undefined,
    hops = 0,
  ): { readonly locales: Locales } | { readonly why: string } => {
    if (node === undefined) return { why: "defineCopy has no registry argument" }
    const expr = unwrap(node)
    if (callsImport(module, expr, "defineLocales", I18N_MODULE)) {
      const config = expr.arguments[0]
      const read = config === undefined ? undefined : readValue(module, config, new Set())
      if (read === undefined || !read.ok) {
        return { why: `the defineLocales config is not static: ${read?.why ?? "no argument"}` }
      }
      try {
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: defineLocales checks its config at run time and throws on a bad one, caught below.
        return { locales: defineLocales(read.value as Parameters<typeof defineLocales>[0]) }
      } catch (error) {
        return { why: error instanceof Error ? error.message : String(error) }
      }
    }
    if (!ts.isIdentifier(expr) || hops > MAX_HOPS) {
      return { why: "the registry is not a defineLocales({...}) constant" }
    }
    const init = module.consts.get(expr.text)
    if (init !== undefined) return registryOf(module, init, hops + 1)
    const imported = module.imports.get(expr.text)
    const target = imported === undefined ? undefined : resolve(imported.from, module.file)
    const declared =
      imported === undefined || target === undefined
        ? undefined
        : declarationOf(target, imported.imported)
    const declaredInit = declared?.module.consts.get(declared.local)
    if (declared === undefined || declaredInit === undefined) {
      return { why: `\`${expr.text}\` does not lead to a defineLocales({...}) constant` }
    }
    return registryOf(declared.module, declaredInit, hops + 1)
  }

  const definition = (ref: CopyDefinitionRef): CopyDefinition | undefined => {
    const key = `${ref.file}\u0000${ref.name}`
    if (definitions.has(key)) return definitions.get(key)
    const module = factsOf(absolute(ref.file))
    const init = module?.consts.get(ref.name)
    let made: CopyDefinition | undefined
    if (module !== undefined && init !== undefined) {
      const call = unwrap(init)
      if (callsImport(module, call, "defineCopy", COPY_MODULE)) {
        const line = module.tree.getLineAndCharacterOfPosition(call.getStart(module.tree)).line + 1
        const registry = registryOf(module, call.arguments[0])
        made =
          "locales" in registry
            ? { ...ref, line, locales: registry.locales }
            : { ...ref, line, unreadable: registry.why }
      }
    }
    definitions.set(key, made)
    return made
  }

  /** The definition a module-level binding is, or leads to. */
  const definitionOfLocal = (module: ModuleFacts, local: string): CopyDefinitionRef | undefined => {
    const imported = module.imports.get(local)
    if (imported === undefined) {
      const ref = { file: relative(module.file), name: local }
      return definition(ref) === undefined ? undefined : ref
    }
    const target = resolve(imported.from, module.file)
    const declared = target === undefined ? undefined : declarationOf(target, imported.imported)
    if (declared === undefined) return undefined
    const ref = { file: relative(declared.module.file), name: declared.local }
    return definition(ref) === undefined ? undefined : ref
  }

  const exportedDefinition = (file: string, name: string): CopyDefinitionRef | undefined => {
    const declared = declarationOf(absolute(file), name)
    if (declared === undefined) return undefined
    const ref = { file: relative(declared.module.file), name: declared.local }
    return definition(ref) === undefined ? undefined : ref
  }

  const tables = (file: string): readonly CopyTableSite[] => {
    const abs = absolute(slash(file))
    const module = factsOf(abs)
    if (module === undefined) return []
    const { tree } = module
    // Copy functions this module can call: by local name, and through namespace imports.
    const bound = new Map<string, CopyDefinitionRef | undefined>()
    const boundAs = (local: string): CopyDefinitionRef | undefined => {
      if (!bound.has(local)) bound.set(local, definitionOfLocal(module, local))
      return bound.get(local)
    }
    const viaNamespace = (ns: string, name: string): CopyDefinitionRef | undefined => {
      const from = module.namespaces.get(ns)
      const target = from === undefined ? undefined : resolve(from, abs)
      return target === undefined ? undefined : exportedDefinition(target, name)
    }
    /** The copy function an expression names, with the text it is reached by. */
    const copyFunction = (
      expr: TS.Expression,
    ): { readonly ref: CopyDefinitionRef; readonly callee: string } | undefined => {
      if (ts.isIdentifier(expr)) {
        const ref =
          module.consts.has(expr.text) || module.imports.has(expr.text)
            ? boundAs(expr.text)
            : undefined
        return ref === undefined ? undefined : { ref, callee: expr.text }
      }
      if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
        const ref = viaNamespace(expr.expression.text, expr.name.text)
        return ref === undefined
          ? undefined
          : { ref, callee: `${expr.expression.text}.${expr.name.text}` }
      }
      return undefined
    }

    type Found = Omit<CopyTableSite, "id" | "values" | "unreadable"> & {
      readonly explicitId: string | undefined
      readonly outcome:
        | { readonly values: Readonly<Record<string, CopyValue>> }
        | { readonly unreadable: string }
    }
    const found: Found[] = []
    const rel = relative(abs)
    // Names a function or block declares, innermost last: a local `copy` there is not the module's.
    const scopes: Set<string>[] = []
    const shadowed = (name: string): boolean => scopes.some((scope) => scope.has(name))
    const visit = (node: TS.Node): void => {
      const scope = scopeOf(ts, node)
      if (scope !== undefined) scopes.push(scope)
      try {
        if (ts.isCallExpression(node) && !calleeShadowed(node.expression)) {
          const site = siteOf(node)
          if (site !== undefined) {
            found.push(site)
            // A table's own arguments hold no further tables.
            return
          }
        }
        ts.forEachChild(node, visit)
      } finally {
        if (scope !== undefined) scopes.pop()
      }
    }
    const calleeShadowed = (callee: TS.Expression): boolean => {
      let base = callee
      while (ts.isPropertyAccessExpression(base)) base = base.expression
      return ts.isIdentifier(base) && shadowed(base.text)
    }
    const siteOf = (node: TS.CallExpression): Found | undefined => {
      const callee = node.expression
      let target = copyFunction(callee)
      let explicitId: string | undefined
      let entries = node.arguments[0]
      let unreadable: string | undefined
      if (
        target === undefined &&
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "id"
      ) {
        target = copyFunction(callee.expression)
        const id = node.arguments[0] === undefined ? undefined : unwrap(node.arguments[0])
        if (
          id !== undefined &&
          (ts.isStringLiteral(id) || ts.isNoSubstitutionTemplateLiteral(id))
        ) {
          explicitId = id.text
        } else {
          unreadable = "the copy.id() id is not a string literal"
        }
        entries = node.arguments[1]
      }
      if (target === undefined) return undefined
      const start = node.getStart(tree)
      const at = tree.getLineAndCharacterOfPosition(start)
      let values: Readonly<Record<string, CopyValue>> | undefined
      if (unreadable === undefined) {
        const read = entries === undefined ? undefined : readValue(module, entries, new Set())
        if (read === undefined || !read.ok) {
          unreadable = read?.why ?? "the table has no argument"
        } else if (isTableValues(read.value)) {
          values = read.value
        } else {
          unreadable = "a table's values must be messages, lists and blocks of them"
        }
      }
      return {
        explicit: explicitId !== undefined,
        explicitId,
        file: rel,
        line: at.line + 1,
        column: at.character + 1,
        start,
        end: node.getEnd(),
        definition: target.ref,
        callee: target.callee,
        outcome:
          values === undefined ? { unreadable: unreadable ?? "the table is not data" } : { values },
      }
    }
    visit(tree)

    const perLine = new Map<number, number>()
    for (const site of found) perLine.set(site.line, (perLine.get(site.line) ?? 0) + 1)
    return found.map(({ explicitId, outcome, ...site }) => {
      const id =
        explicitId ??
        ((perLine.get(site.line) ?? 0) > 1
          ? `${rel}:${site.line}:${site.column}`
          : `${rel}:${site.line}`)
      return { id, ...site, ...outcome }
    })
  }

  const rewrite = (file: string): string | undefined => {
    const abs = absolute(slash(file))
    if (!/\.(?:m?[jt]sx?)$/.test(abs)) return undefined
    const module = factsOf(abs)
    const text = host.read(abs)
    if (module === undefined || text === undefined) return undefined
    const split = tables(abs).filter(
      (site) => site.values !== undefined && definition(site.definition)?.locales !== undefined,
    )
    const first = split[0]
    if (first === undefined) return undefined
    const { tree } = module
    // Load before the first top-level statement holding a table, and after the statement that declares
    // a copy function this module defines itself.
    let at =
      tree.statements.find((statement) => statement.getEnd() > first.start)?.getStart(tree) ?? 0
    const callees = [...new Set(split.map((site) => site.callee))]
    for (const callee of callees) {
      const declared = module.statements.get(callee.split(".", 1)[0] ?? callee)
      if (declared !== undefined && declared.getEnd() > at) at = declared.getEnd()
    }
    const load =
      callees.length === 1
        ? `await ${callees[0]}.load();`
        : `await Promise.all([${callees.map((callee) => `${callee}.load()`).join(", ")}]);`
    const edits: { readonly start: number; readonly end: number; readonly text: string }[] = [
      { start: at, end: at, text: load },
      ...split.map((site) => {
        const breaks = text.slice(site.start, site.end).split("\n").length - 1
        return {
          start: site.start,
          end: site.end,
          text: `__nifraCopyRef(${JSON.stringify(copyChunkId(site.id))}${"\n".repeat(breaks)})`,
        }
      }),
    ].sort((a, b) => b.start - a.start || b.end - a.end)
    let out = text
    for (const edit of edits) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
    // Last, so no line moves; an import is hoisted wherever it is written.
    return `${out}${out.endsWith("\n") ? "" : "\n"}${REF_IMPORT}\n`
  }

  return {
    tables,
    definition,
    exportedDefinition: (file, name) => exportedDefinition(slash(file), name),
    rewrite,
  }
}

function isCopyValue(value: unknown, depth = 0): value is CopyValue {
  if (typeof value === "string") return true
  if (depth > 32 || value === null || typeof value !== "object") return false
  return Array.isArray(value)
    ? value.every((item) => isCopyValue(item, depth + 1))
    : Object.values(value).every((item) => isCopyValue(item, depth + 1))
}

/** Whether a read value is a table's entries: copy values by locale key. */
function isTableValues(value: unknown): value is Readonly<Record<string, CopyValue>> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => isCopyValue(item))
  )
}

/** The names a function-like node or a block declares, for shadowing; `undefined` for other nodes. */
function scopeOf(ts: typeof TS, node: TS.Node): Set<string> | undefined {
  const names = new Set<string>()
  const bind = (name: TS.BindingName): void => {
    if (ts.isIdentifier(name)) {
      names.add(name.text)
      return
    }
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) bind(element.name)
    }
  }
  if (ts.isFunctionLike(node)) {
    for (const parameter of node.parameters) bind(parameter.name)
    // `var` and nested declarations are hoisted to the function, so its whole body counts.
    const collect = (child: TS.Node): void => {
      if (ts.isFunctionLike(child)) {
        if (ts.isFunctionDeclaration(child) && child.name !== undefined) names.add(child.name.text)
        return
      }
      if (ts.isVariableDeclaration(child)) bind(child.name)
      else if (ts.isClassDeclaration(child) && child.name !== undefined) names.add(child.name.text)
      else if (ts.isCatchClause(child) && child.variableDeclaration !== undefined)
        bind(child.variableDeclaration.name)
      ts.forEachChild(child, collect)
    }
    const body: unknown = "body" in node ? node.body : undefined
    if (isNode(body)) ts.forEachChild(body, collect)
    return names
  }
  return undefined
}

/** The root tsconfig's `paths`, as absolute target patterns, longest prefix first. */
function tsconfigPaths(
  ts: typeof TS,
  root: string,
): readonly (readonly [string, readonly string[]])[] {
  // TypeScript's own reader, so `extends` and comments behave as tsc reads them. Absent from a compiler
  // object without the config API.
  if (typeof ts.readConfigFile !== "function" || ts.sys === undefined) return []
  const file = `${root}/tsconfig.json`
  const config = ts.readConfigFile(file, ts.sys.readFile)
  if (config.error !== undefined || config.config === undefined) return []
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
  const { paths, baseUrl } = parsed.options
  if (paths === undefined) return []
  // Where `paths` resolve from without a `baseUrl`: the tsconfig that declares them, which TypeScript
  // records under an internal option.
  const pathsBase: unknown = Reflect.get(parsed.options, "pathsBasePath")
  const base = slash(baseUrl ?? (typeof pathsBase === "string" ? pathsBase : root))
  return Object.entries(paths)
    .map(
      ([pattern, targets]) =>
        [pattern, targets.map((target) => joinPath(base, slash(target)))] as const,
    )
    .sort((a, b) => b[0].length - a[0].length)
}

/** Parse a module and index what the scanner reads from it. */
function readModule(ts: typeof TS, file: string, text: string): ModuleFacts {
  const kind = /\.[cm]?tsx$/.test(file)
    ? ts.ScriptKind.TSX
    : /\.jsx$/.test(file)
      ? ts.ScriptKind.JSX
      : /\.[cm]?js$/.test(file)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
  const module: ModuleFacts = {
    file,
    tree,
    imports: new Map(),
    namespaces: new Map(),
    exports: new Map(),
    reexports: [],
    starExports: [],
    consts: new Map(),
    statements: new Map(),
  }
  // Read from the node, not `ts.getModifiers`: TypeScript 7's API has no getModifiers.
  const exported = (statement: TS.VariableStatement): boolean =>
    statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
  for (const statement of tree.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue
      const from = statement.moduleSpecifier.text
      const clause = statement.importClause
      if (clause === undefined || clause.isTypeOnly) continue
      if (clause.name !== undefined)
        module.imports.set(clause.name.text, { from, imported: "default" })
      const bindings = clause.namedBindings
      if (bindings === undefined) continue
      if (ts.isNamespaceImport(bindings)) {
        module.namespaces.set(bindings.name.text, from)
        continue
      }
      for (const element of bindings.elements) {
        if (element.isTypeOnly) continue
        module.imports.set(element.name.text, {
          from,
          imported: (element.propertyName ?? element.name).text,
        })
      }
      continue
    }
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue
      const from =
        statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : undefined
      const clause = statement.exportClause
      if (clause === undefined) {
        if (from !== undefined) module.starExports.push(from)
        continue
      }
      if (!ts.isNamedExports(clause)) continue
      for (const element of clause.elements) {
        if (element.isTypeOnly) continue
        const local = (element.propertyName ?? element.name).text
        if (from === undefined) module.exports.set(element.name.text, local)
        else module.reexports.push({ from, imported: local, exported: element.name.text })
      }
      continue
    }
    if (!ts.isVariableStatement(statement)) continue
    const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue
      const name = declaration.name.text
      module.statements.set(name, statement)
      if (isConst && declaration.initializer !== undefined) {
        module.consts.set(name, declaration.initializer)
      }
      if (exported(statement)) module.exports.set(name, name)
    }
  }
  return module
}

const isNode = (value: unknown): value is TS.Node =>
  typeof value === "object" && value !== null && "kind" in value && typeof value.kind === "number"
