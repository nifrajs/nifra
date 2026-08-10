import type { Diagnostic } from "../diagnostics.ts"
import { isBuiltInCode } from "./codes.ts"

export interface SourceFile {
  readonly file: string
  readonly content: string
}

export interface SourceIndex {
  readonly files: readonly string[]
  read(file: string): string | undefined
}

export interface ProjectFacts {
  readonly [key: string]: unknown
}

export interface RuleContext {
  readonly root: string
  readonly sources: SourceIndex
  readonly project: ProjectFacts
}

export interface CheckRule {
  readonly code: string
  readonly title: string
  scan(ctx: RuleContext): Promise<Diagnostic[]>
}

export interface RulePack {
  readonly name: string
  readonly rules: readonly CheckRule[]
}

export function validateRulePacks(packs: readonly RulePack[] | undefined): readonly RulePack[] {
  if (packs === undefined) return []
  const names = new Set<string>()
  const codes = new Set<string>()
  const normalized: RulePack[] = []
  for (const pack of packs) {
    if (typeof pack?.name !== "string" || pack.name.trim() === "")
      throw new Error("rule pack name must be a non-empty string")
    if (names.has(pack.name)) throw new Error(`duplicate rule pack: ${pack.name}`)
    names.add(pack.name)
    if (!Array.isArray(pack.rules)) throw new Error(`rule pack ${pack.name} must contain rules`)
    const rules: CheckRule[] = []
    for (const rule of pack.rules) {
      if (
        typeof rule?.code !== "string" ||
        typeof rule.title !== "string" ||
        typeof rule.scan !== "function"
      ) {
        throw new Error(`rule pack ${pack.name} contains an invalid rule`)
      }
      if (rule.code.startsWith("NF-"))
        throw new Error(`application rule pack code ${rule.code} uses the reserved NF- prefix`)
      if (codes.has(rule.code)) throw new Error(`duplicate application rule code: ${rule.code}`)
      codes.add(rule.code)
      rules.push(rule)
    }
    normalized.push(Object.freeze({ name: pack.name, rules: Object.freeze(rules) }))
  }
  return Object.freeze(normalized)
}

export function parseRulePacks(value: unknown): readonly RulePack[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new TypeError("rulePacks must be an array")
  const packs: RulePack[] = []
  for (const rawPack of value) {
    if (typeof rawPack !== "object" || rawPack === null || Array.isArray(rawPack))
      throw new TypeError("rule pack must be an object")
    const packRecord = Object.fromEntries(Object.entries(rawPack))
    const name = packRecord.name
    const rawRules = packRecord.rules
    if (typeof name !== "string" || !Array.isArray(rawRules))
      throw new TypeError("rule pack requires a name and rules array")
    const rules: CheckRule[] = []
    for (const rawRule of rawRules) {
      if (typeof rawRule !== "object" || rawRule === null || Array.isArray(rawRule))
        throw new TypeError(`rule pack ${name} contains an invalid rule`)
      const ruleRecord = Object.fromEntries(Object.entries(rawRule))
      if (
        typeof ruleRecord.code !== "string" ||
        typeof ruleRecord.title !== "string" ||
        typeof ruleRecord.scan !== "function"
      ) {
        throw new TypeError(`rule pack ${name} contains an invalid rule`)
      }
      const scan = ruleRecord.scan
      rules.push({
        code: ruleRecord.code,
        title: ruleRecord.title,
        scan: async (ctx) => {
          const result: unknown = await Reflect.apply(scan, undefined, [ctx])
          if (!Array.isArray(result))
            throw new TypeError(`rule ${ruleRecord.code} did not return diagnostics`)
          const findings: Diagnostic[] = []
          for (const item of result) {
            if (typeof item !== "object" || item === null || Array.isArray(item))
              throw new TypeError(`rule ${ruleRecord.code} returned an invalid diagnostic`)
            const finding = Object.fromEntries(Object.entries(item))
            if (
              typeof finding.code !== "string" ||
              (finding.severity !== "error" &&
                finding.severity !== "warn" &&
                finding.severity !== "info") ||
              typeof finding.message !== "string"
            ) {
              throw new TypeError(`rule ${ruleRecord.code} returned an invalid diagnostic`)
            }
            const code = finding.code
            const severity = finding.severity
            const message = finding.message
            const rawFix =
              typeof finding.fix === "object" && finding.fix !== null && !Array.isArray(finding.fix)
                ? Object.fromEntries(Object.entries(finding.fix))
                : undefined
            findings.push({
              code,
              severity,
              message,
              ...(typeof finding.file === "string" ? { file: finding.file } : {}),
              ...(typeof finding.line === "number" ? { line: finding.line } : {}),
              ...(Array.isArray(finding.evidence)
                ? {
                    evidence: finding.evidence.filter(
                      (item): item is string => typeof item === "string",
                    ),
                  }
                : {}),
              ...(typeof rawFix?.recipe === "string"
                ? {
                    fix: {
                      recipe: rawFix.recipe,
                      ...(typeof rawFix.command === "string" ? { command: rawFix.command } : {}),
                    },
                  }
                : {}),
              ...(typeof finding.verify === "string" ? { verify: finding.verify } : {}),
            })
          }
          return findings
        },
      })
    }
    packs.push({ name, rules })
  }
  return validateRulePacks(packs)
}

export async function runRuleRegistry(
  ctx: RuleContext,
  builtIns: readonly CheckRule[],
  packs: readonly RulePack[] = [],
): Promise<Diagnostic[]> {
  const rules = [...builtIns, ...validateRulePacks(packs).flatMap((pack) => pack.rules)]
  const out: Diagnostic[] = []
  for (const rule of rules) {
    if (isBuiltInCode(rule.code) === false && rule.code.startsWith("NF-")) {
      throw new Error(`application rule pack code ${rule.code} uses the reserved NF- prefix`)
    }
    const findings = await rule.scan(ctx)
    out.push(...findings)
  }
  return out
}

export function sourceIndex(files: readonly SourceFile[]): SourceIndex {
  const map = new Map(files.map((file) => [file.file, file.content]))
  return Object.freeze({
    files: Object.freeze(files.map((file) => file.file)),
    read: (file: string) => map.get(file),
  })
}
