/**
 * NF-C030 and NF-C031: the data guard, checked from source.
 *
 * The server enforces both at runtime, on every request: data a loader or action returns without an
 * output schema fails the request, and an output schema naming a sensitive field without
 * `t.declassified` fails the route when it loads. These report what source alone shows, before a
 * request ever does. NF-C030 is a warning because only running the loader proves it returns data.
 */
import { isSensitiveFieldName } from "@nifrajs/web/zones"
import { codePositionMask } from "../check-scan.ts"
import { type Diagnostic, diagnostic } from "../diagnostics.ts"
import type { CheckRule } from "./index.ts"
import { zonedFiles } from "./zones.ts"

const lineAt = (text: string, index: number): number => text.slice(0, index).split("\n").length

const byPlace = (a: Diagnostic, b: Diagnostic): number =>
  (a.file ?? "").localeCompare(b.file ?? "") || (a.line ?? 0) - (b.line ?? 0)

const exported = (mask: string, name: string): RegExpExecArray | null =>
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

/**
 * Whether the function exported as `name` may return data, read from its type-stripped source: an
 * arrow's expression body, or a `return <value>` that is not a redirect or a status.
 */
function mayReturnData(js: string, name: string): boolean {
  const mask = codePositionMask(js)
  const found = exported(mask, name)
  if (found === null || found[0].startsWith("export {") || found[0].startsWith("export{")) {
    return true // declared elsewhere in the file and re-exported: assume it does
  }
  const params = mask.indexOf("(", found.index + found[0].length)
  if (params === -1) return true
  let at = closing(mask, params) + 1
  while (/\s/.test(mask[at] ?? "")) at++
  if (mask.startsWith("=>", at)) {
    at += 2
    while (/\s/.test(mask[at] ?? "")) at++
    if (mask[at] !== "{") return !CONTROL_FLOW.test(js.slice(at, at + 40))
  }
  if (mask[at] !== "{") return true
  const body = mask.slice(at, closing(mask, at))
  for (const match of body.matchAll(/\breturn\b/g)) {
    const from = at + match.index + "return".length
    const rest = js.slice(from, from + 40).replace(/^[ \t]+/, "")
    if (!CONTROL_FLOW.test(rest)) return true
  }
  return false
}

/** Where an expression starting at `start` ends: a `,`, `;` or closer at its own depth. */
function expressionEnd(mask: string, start: number): number {
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

export const missingOutputRule: CheckRule = {
  code: "NF-C030",
  title: "Route data without an output schema",
  async scan(ctx) {
    const findings: Diagnostic[] = []
    const transpiler = new Bun.Transpiler({ loader: "ts" })
    for (const { file, classification } of zonedFiles(ctx).files) {
      if (classification.zone !== "route-backend") continue
      const content = ctx.sources.read(file)
      if (content === undefined) continue
      const mask = codePositionMask(content)
      let js: string | undefined
      for (const [name, schema] of [
        ["loader", "loaderOutput"],
        ["action", "actionOutput"],
      ] as const) {
        const fn = exported(mask, name)
        if (fn === null || exported(mask, schema) !== null) continue
        try {
          js ??= transpiler.transformSync(content)
        } catch {
          js = content
        }
        if (!mayReturnData(js, name)) continue
        findings.push(
          diagnostic({
            code: "NF-C030",
            severity: "warn",
            file,
            line: lineAt(content, fn.index),
            message: `${file} exports a ${name} but no ${schema}. Data it returns fails the request: everything sent to the browser needs an output schema. Export one: export const ${schema} = t.object({ ... })`,
            evidence: [`export: ${name}`, `missing: ${schema}`],
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

export const sensitiveOutputRule: CheckRule = {
  code: "NF-C031",
  title: "Sensitive field in an output schema",
  async scan(ctx) {
    const findings: Diagnostic[] = []
    for (const { file, classification } of zonedFiles(ctx).files) {
      if (classification.zone !== "route-backend" && classification.zone !== "fn") continue
      const content = ctx.sources.read(file)
      if (content === undefined) continue
      const mask = codePositionMask(content)
      for (const declaration of mask.matchAll(OUTPUT_DECLARATION)) {
        const start = declaration.index + declaration[0].length
        for (const { key, index } of sensitiveKeys(
          content,
          mask,
          start,
          expressionEnd(mask, start),
        )) {
          findings.push(
            diagnostic({
              code: "NF-C031",
              severity: "error",
              file,
              line: lineAt(content, index),
              message: `${file} declares "${key}" in an output schema, a field name that usually holds a credential or personal identifier. Remove it, or wrap its schema in t.declassified("why it may reach the browser", ...)`,
              evidence: [`field: ${key}`],
              verify: "nifra check",
            }),
          )
        }
      }
    }
    return findings.sort(byPlace)
  },
}

export const dataGuardRules = Object.freeze([missingOutputRule, sensitiveOutputRule])
