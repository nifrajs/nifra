/**
 * NF-C030 and NF-C031: the data guard, checked from source.
 *
 * The server enforces both at runtime, on every request: data a loader or action returns without an
 * output schema fails the request, and an output schema naming a sensitive field without
 * `t.declassified` fails the route when it loads. These report what source alone shows, before a
 * request ever does. NF-C030 is an error when the loader's own body returns a literal the runtime
 * refuses (an object, array, string, number or boolean) and a warning otherwise, since only running
 * the loader proves what an expression evaluates to.
 */
import { realpathSync } from "node:fs"
import { isAbsolute, join, relative } from "node:path"
import { isSensitiveFieldName } from "@nifrajs/web/zones"
import { codePositionMask } from "../check-scan.ts"
import { type Diagnostic, diagnostic } from "../diagnostics.ts"
import { codeUnitOrder } from "../internal/code-unit-order.ts"
import { createSpecifierResolver } from "../internal/project-specifiers.ts"
import type { CheckRule } from "./index.ts"
import { zonedFiles } from "./zones.ts"

const lineAt = (text: string, index: number): number => text.slice(0, index).split("\n").length

const byPlace = (a: Diagnostic, b: Diagnostic): number =>
  codeUnitOrder(a.file ?? "", b.file ?? "") || (a.line ?? 0) - (b.line ?? 0)

/** The export statement of `name` in a code-position mask: a declaration or an `export { }` list. */
export const exported = (mask: string, name: string): RegExpExecArray | null =>
  new RegExp(
    `\\bexport\\s+(?:(?:async\\s+)?function\\s*\\*?\\s*|(?:const|let|var)\\s+)${name}\\b|\\bexport\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`,
  ).exec(mask)

/** A return that hands the browser nothing: a bare return, a redirect, a status, a thrown signal. */
const CONTROL_FLOW =
  /^(?:;|$|null\b|undefined\b|redirect\s*\(|notFound\s*\(|gone\s*\(|statusPage\s*\(|new\s+Response\s*\(|Response\s*\.)/

const closing = (mask: string, open: number): number => {
  let depth = 0
  for (let i = open; i < mask.length; i++) {
    const c = mask[i]
    if (c === "(" || c === "{" || c === "[") depth++
    else if (c === ")" || c === "}" || c === "]") {
      depth--
      if (depth === 0) return i
    }
  }
  return mask.length
}

const opening = (mask: string, close: number): number => {
  let depth = 0
  for (let i = close; i >= 0; i--) {
    const c = mask[i]
    if (c === ")" || c === "}" || c === "]") depth++
    else if (c === "(" || c === "{" || c === "[") {
      depth--
      if (depth === 0) return i
    }
  }
  return 0
}

const CONTROL_HEAD = /(?:^|[^\w$.])(?:if|for(?:\s+await)?|while|catch|switch|with)\s*$/
const BLOCK_WORD = /(?:^|[^\w$.])(?:else|try|finally|do)$/

/**
 * Whether the `{` at `open` starts a statement block of the enclosing function: after a control
 * head, `else`/`try`/`finally`/`do`, or a statement boundary. A function, method, class, object or
 * `case` body is not one, so a `return` inside it is never counted as the outer function's.
 */
function isStatementBlock(mask: string, open: number): boolean {
  let p = open - 1
  while (p >= 0 && /\s/.test(mask[p] ?? "")) p--
  const prev = mask[p]
  if (prev === undefined || prev === ";" || prev === "{" || prev === "}") return true
  if (prev === ")") {
    const head = opening(mask, p)
    return CONTROL_HEAD.test(mask.slice(Math.max(0, head - 16), head))
  }
  return BLOCK_WORD.test(mask.slice(Math.max(0, p - 8), p + 1))
}

/** Offsets of the `return`s that belong to the block at `open` itself, not to a nested function. */
function ownReturns(mask: string, open: number, close: number): number[] {
  const own: boolean[] = []
  const found: number[] = []
  for (let i = open; i < close; i++) {
    const c = mask[i]
    if (c === "{") own.push(i === open || (own.at(-1) === true && isStatementBlock(mask, i)))
    else if (c === "}") own.pop()
    else if (
      c === "r" &&
      own.at(-1) === true &&
      mask.startsWith("return", i) &&
      !/[\w$.]/.test(mask[i - 1] ?? "") &&
      !/[\w$]/.test(mask[i + 6] ?? "")
    ) {
      found.push(i)
    }
  }
  return found
}

const NUMBER = /^-?(?:0[xob][\da-f_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:e[+-]?\d+)?)n?$/i

/**
 * Whether the expression at `start` is one literal the runtime refuses without an output schema: an
 * object, array, string, template, number or boolean, alone, not part of a larger expression.
 */
function isDataLiteral(js: string, mask: string, start: number): boolean {
  let from = start
  let to = expressionEnd(mask, start)
  for (;;) {
    // Skip on the source: the mask blanks a string literal, quotes included.
    while (from < to && /\s/.test(js[from] ?? "")) from++
    while (to > from && /\s/.test(js[to - 1] ?? "")) to--
    if (from >= to) return false
    if (mask[from] !== "(" || closing(mask, from) !== to - 1) break
    from++
    to--
  }
  const first = mask[from]
  if (first === "{" || first === "[") return closing(mask, from) === to - 1
  const text = mask.slice(from, to)
  if (text.trim() === "") {
    const quote = js[from] ?? ""
    return `"'\``.includes(quote) && js[to - 1] === quote
  }
  return NUMBER.test(text) || text === "true" || text === "false"
}

type DataReturn = "none" | "possible" | "proven"

/**
 * What the function exported as `name` returns, read from its type-stripped source. `proven` when
 * its expression body, or a `return` of its own body, is a data literal; `possible` when an
 * expression body or some `return <value>` is not a redirect or a status; `none` otherwise.
 */
function dataReturn(js: string, name: string): DataReturn {
  const mask = codePositionMask(js)
  const found = exported(mask, name)
  if (found === null || found[0].startsWith("export {") || found[0].startsWith("export{")) {
    return "possible" // declared elsewhere in the file and re-exported: assume it does
  }
  const params = mask.indexOf("(", found.index + found[0].length)
  if (params === -1) return "possible"
  let at = closing(mask, params) + 1
  while (/\s/.test(mask[at] ?? "")) at++
  if (mask.startsWith("=>", at)) {
    at += 2
    while (/\s/.test(js[at] ?? "")) at++
    if (mask[at] !== "{") {
      if (CONTROL_FLOW.test(js.slice(at, at + 40))) return "none"
      return isDataLiteral(js, mask, at) ? "proven" : "possible"
    }
  }
  if (mask[at] !== "{") return "possible"
  const end = closing(mask, at)
  for (const index of ownReturns(mask, at, end)) {
    if (isDataLiteral(js, mask, index + "return".length)) return "proven"
  }
  const body = mask.slice(at, end)
  for (const match of body.matchAll(/\breturn\b/g)) {
    const from = at + match.index + "return".length
    const rest = js.slice(from, from + 40).replace(/^[ \t]+/, "")
    if (!CONTROL_FLOW.test(rest)) return "possible"
  }
  return "none"
}

/** Where an expression starting at `start` ends: a `,`, `;` or closer at its own depth. */
export function expressionEnd(mask: string, start: number): number {
  let depth = 0
  for (let i = start; i < mask.length; i++) {
    const c = mask[i]
    if (c === "(" || c === "{" || c === "[") depth++
    else if (c === ")" || c === "}" || c === "]") {
      if (depth === 0) return i
      depth--
    } else if (depth === 0 && (c === "," || c === ";")) return i
    else if (depth === 0 && c === "\n") {
      const next = /\S/.exec(mask.slice(i))?.[0]
      const prev = /\S(?=\s*$)/.exec(mask.slice(start, i))?.[0]
      if (
        next !== undefined &&
        !".?:+-*/&|".includes(next) &&
        !"=(,[{:?+-*/&|".includes(prev ?? "")
      ) {
        return i
      }
    }
  }
  return mask.length
}

/** Object keys inside `[start, end)` whose name is sensitive and whose value is not declassified. */
function sensitiveKeys(
  src: string,
  mask: string,
  start: number,
  end: number,
): Array<{ readonly key: string; readonly index: number }> {
  const found: Array<{ key: string; index: number }> = []
  for (
    let colon = mask.indexOf(":", start);
    colon !== -1 && colon < end;
    colon = mask.indexOf(":", colon + 1)
  ) {
    let k = colon - 1
    while (k >= start && /\s/.test(src[k] ?? "")) k--
    let key: string
    let keyStart: number
    if (/[\w$]/.test(mask[k] ?? "")) {
      keyStart = k
      while (keyStart > start && /[\w$]/.test(mask[keyStart - 1] ?? "")) keyStart--
      key = mask.slice(keyStart, k + 1)
    } else if (src[k] === '"' || src[k] === "'") {
      keyStart = src.lastIndexOf(src[k] as string, k - 1)
      if (keyStart < start) continue
      key = src.slice(keyStart + 1, k)
    } else continue
    let p = keyStart - 1
    while (p >= start && /\s/.test(mask[p] ?? "")) p--
    if (mask[p] !== "{" && mask[p] !== ",") continue
    if (!isSensitiveFieldName(key)) continue
    const value = src.slice(colon + 1, colon + 80).trimStart()
    if (/^[\w$.]*declassified\s*\(/.test(value)) continue
    found.push({ key, index: keyStart })
  }
  return found
}

export interface MissingOutputSchema {
  readonly name: "loader" | "action"
  readonly schema: "loaderOutput" | "actionOutput"
  readonly line: number
  /** Its own body returns a data literal, so every request that reaches that return fails. */
  readonly proven: boolean
}

let transpiler: Bun.Transpiler | undefined

/** The loader and action a route's backend half exports, may return data from, and gives no schema. */
export function missingOutputSchemas(content: string): MissingOutputSchema[] {
  const mask = codePositionMask(content)
  const missing: MissingOutputSchema[] = []
  let js: string | undefined
  for (const [name, schema] of [
    ["loader", "loaderOutput"],
    ["action", "actionOutput"],
  ] as const) {
    const fn = exported(mask, name)
    if (fn === null || exported(mask, schema) !== null) continue
    try {
      transpiler ??= new Bun.Transpiler({ loader: "ts" })
      js ??= transpiler.transformSync(content)
    } catch {
      js = content
    }
    const returns = dataReturn(js, name)
    if (returns !== "none") {
      missing.push({ name, schema, line: lineAt(content, fn.index), proven: returns === "proven" })
    }
  }
  return missing
}

export const missingOutputRule: CheckRule = {
  code: "NF-C030",
  title: "Route data without an output schema",
  async scan(ctx) {
    const findings: Diagnostic[] = []
    for (const { file, classification } of zonedFiles(ctx).files) {
      if (classification.zone !== "route-backend") continue
      const content = ctx.sources.read(file)
      if (content === undefined) continue
      for (const { name, schema, line, proven } of missingOutputSchemas(content)) {
        const returns = proven
          ? "It returns a data literal, so every request that reaches that return fails"
          : "Data it returns fails the request"
        findings.push(
          diagnostic({
            code: "NF-C030",
            severity: proven ? "error" : "warn",
            file,
            line,
            message: `${file} exports a ${name} but no ${schema}. ${returns}: everything sent to the browser needs an output schema. Export one: export const ${schema} = t.object({ ... })`,
            evidence: [
              `export: ${name}`,
              `missing: ${schema}`,
              ...(proven ? ["returns: a data literal"] : []),
            ],
            verify: "nifra check",
          }),
        )
      }
    }
    return findings.sort(byPlace)
  },
}

const OUTPUT_DECLARATION =
  /\bexport\s+(?:const|let|var)\s+(?:loaderOutput|actionOutput)\b[^=]*=|\boutput\s*:/g

/** The initializer of the top-level `const`/`let`/`var` named `name`, as an offset just past its `=`. */
function declarationOf(mask: string, name: string): number | undefined {
  const declaration = new RegExp(
    `(?:^|\\n)(?:export\\s+)?(?:const|let|var)\\s+${name.replaceAll("$", "\\$")}(?![\\w$])[^=]*=`,
  ).exec(mask)
  return declaration === null ? undefined : declaration.index + declaration[0].length
}

/**
 * Where the schema an output declaration names is written: the expression itself, or, when it is a
 * bare name, the initializer of the top-level declaration of that name in the same file, followed
 * through aliases.
 */
function schemaExpression(mask: string, start: number): { start: number; end: number } {
  let range = { start, end: expressionEnd(mask, start) }
  const seen = new Set<string>()
  for (;;) {
    const name = mask.slice(range.start, range.end).trim()
    if (!/^[A-Za-z_$][\w$]*$/.test(name) || seen.has(name)) return range
    seen.add(name)
    const from = declarationOf(mask, name)
    if (from === undefined) return range
    range = { start: from, end: expressionEnd(mask, from) }
  }
}

/** A name used as a value: not an object key, a member, a callee, or the object of a member. */
const VALUE_NAME = /(?<![\w$.])[A-Za-z_$][\w$]*(?![\w$])(?!\s*[:(.])/g

/** The module `name` is imported from as a named import, and its name there. */
function importOf(
  source: SchemaSource,
  name: string,
): { readonly specifier: string; readonly name: string } | undefined {
  // The mask blanks the specifier string, so it is read from the source past `from`.
  for (const clause of source.mask.matchAll(/\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\b/g)) {
    const quoted = /^\s*(["'])([^"']+)\1/.exec(
      source.content.slice(clause.index + clause[0].length),
    )
    if (quoted === null) continue
    for (const element of (clause[1] ?? "").split(",")) {
      const [imported, local = imported] = element
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)
      if (local === name && imported !== undefined)
        return { specifier: quoted[2] ?? "", name: imported }
    }
  }
  return undefined
}

interface SchemaSource {
  readonly file: string
  readonly content: string
  readonly mask: string
}

interface SchemaRange {
  readonly source: SchemaSource
  readonly start: number
  readonly end: number
}

/**
 * Every place an output schema is written: its own expression, then each schema it names inside it
 * (`t.object({ user: userSchema })`), followed to this file's top-level declaration of that name or
 * to the project file it is imported from. A schema under `declassified(...)` is not followed.
 */
function schemaRanges(
  origin: SchemaSource,
  start: number,
  load: (from: string, specifier: string) => SchemaSource | undefined,
): SchemaRange[] {
  const ranges: SchemaRange[] = [{ source: origin, ...schemaExpression(origin.mask, start) }]
  const seen = new Set<string>()
  // An array iterator reads the length each step, so ranges pushed below are walked too.
  for (const { source, start: from, end } of ranges) {
    const declassified: Array<readonly [number, number]> = []
    for (const call of source.mask.slice(from, end).matchAll(/\bdeclassified\s*\(/g)) {
      const open = from + call.index + call[0].length - 1
      declassified.push([open, closing(source.mask, open)])
    }
    for (const reference of source.mask.slice(from, end).matchAll(VALUE_NAME)) {
      const at = from + reference.index
      if (declassified.some(([open, close]) => at > open && at < close)) continue
      const name = reference[0]
      if (seen.has(`${source.file}#${name}`)) continue
      seen.add(`${source.file}#${name}`)
      const local = declarationOf(source.mask, name)
      if (local !== undefined) {
        ranges.push({ source, start: local, end: expressionEnd(source.mask, local) })
        continue
      }
      const imported = importOf(source, name)
      const target = imported === undefined ? undefined : load(source.file, imported.specifier)
      const there =
        target === undefined ? undefined : declarationOf(target.mask, imported?.name ?? "")
      if (target !== undefined && there !== undefined) {
        ranges.push({ source: target, start: there, end: expressionEnd(target.mask, there) })
      }
    }
  }
  return ranges
}

export const sensitiveOutputRule: CheckRule = {
  code: "NF-C031",
  title: "Sensitive field in an output schema",
  async scan(ctx) {
    const findings: Diagnostic[] = []
    const resolve = createSpecifierResolver()
    const realRoot = (() => {
      try {
        return realpathSync(ctx.root)
      } catch {
        return ctx.root
      }
    })()
    const sources = new Map<string, SchemaSource | undefined>()
    const sourceOf = (file: string): SchemaSource | undefined => {
      if (!sources.has(file)) {
        const content = ctx.sources.read(file)
        sources.set(
          file,
          content === undefined ? undefined : { file, content, mask: codePositionMask(content) },
        )
      }
      return sources.get(file)
    }
    // Only project source: an installed package's schemas are not the app's to rename.
    const load = (from: string, specifier: string): SchemaSource | undefined => {
      const target = resolve(join(ctx.root, from), specifier)
      if (target === undefined) return undefined
      const rel = relative(realRoot, target).replaceAll("\\", "/")
      if (rel.startsWith("../") || isAbsolute(rel) || rel.split("/").includes("node_modules")) {
        return undefined
      }
      return sourceOf(rel)
    }
    // A schema several declarations name, or several routes import, is reported once.
    const reported = new Set<string>()
    for (const { file, classification } of zonedFiles(ctx).files) {
      if (classification.zone !== "route-backend" && classification.zone !== "fn") continue
      const origin = sourceOf(file)
      if (origin === undefined) continue
      for (const declaration of origin.mask.matchAll(OUTPUT_DECLARATION)) {
        const ranges = schemaRanges(origin, declaration.index + declaration[0].length, load)
        for (const { source, start, end } of ranges) {
          for (const { key, index } of sensitiveKeys(source.content, source.mask, start, end)) {
            if (reported.has(`${source.file}:${index}`)) continue
            reported.add(`${source.file}:${index}`)
            findings.push(
              diagnostic({
                code: "NF-C031",
                severity: "error",
                file: source.file,
                line: lineAt(source.content, index),
                message: `${source.file} declares "${key}" in an output schema, a field name that usually holds a credential or personal identifier. Remove it, or wrap its schema in t.declassified("why it may reach the browser", ...)`,
                evidence: [`field: ${key}`],
                verify: "nifra check",
              }),
            )
          }
        }
      }
    }
    return findings.sort(byPlace)
  },
}

export const staleGeneratedOutputRule: CheckRule = {
  code: "NF-C033",
  title: "Generated output schema out of date",
  async scan(ctx) {
    const files = zonedFiles(ctx)
      .files.filter((entry) => entry.classification.zone === "route-backend")
      .map((entry) => entry.file)
      .filter((file) => ctx.sources.read(file)?.includes("nifra:generated") === true)
    if (files.length === 0) return []
    const { staleGeneratedSchemas } = await import("../output-schemas.ts")
    const { stale, unchecked, warnings } = await staleGeneratedSchemas(ctx.root, files, (file) =>
      ctx.sources.read(file),
    )
    // A generated schema that could not be compared is reported, never passed silently.
    const notChecked = [
      ...warnings.map((warning) =>
        diagnostic({
          code: "NF-C033",
          severity: "warn",
          message: `${files.length} generated output schema(s) were not checked: ${warning}`,
          evidence: files.map((file) => `file: ${file}`),
          verify: "nifra schemas",
        }),
      ),
      ...unchecked.map((entry) =>
        diagnostic({
          code: "NF-C033",
          severity: "warn",
          file: entry.file,
          line: entry.line,
          message: `${entry.file}'s generated ${entry.schema} was not checked: ${entry.reason ?? "its type could not be read"}`,
          evidence: [`schema: ${entry.schema}`],
          verify: "nifra schemas",
        }),
      ),
    ]
    return [
      ...notChecked,
      ...stale.map((entry) => {
        const fn = entry.schema === "loaderOutput" ? "loader" : "action"
        const change =
          entry.edited === true
            ? "it was edited by hand since"
            : entry.dropped.length > 0
              ? `it now returns ${entry.dropped.join(", ")}, which the schema drops`
              : "what it returns has changed"
        return diagnostic({
          code: "NF-C033",
          severity: "error",
          file: entry.file,
          line: entry.line,
          message: `${entry.file}'s ${entry.schema} was generated from the ${fn}'s return type, and ${change}. Run \`nifra schemas --write\` to regenerate it, or delete its "nifra:generated" line to own it by hand.`,
          evidence: [`schema: ${entry.schema}`, ...entry.dropped.map((path) => `dropped: ${path}`)],
          verify: "nifra schemas",
        })
      }),
    ]
  },
}

export const dataGuardRules = Object.freeze([
  missingOutputRule,
  sensitiveOutputRule,
  staleGeneratedOutputRule,
])
