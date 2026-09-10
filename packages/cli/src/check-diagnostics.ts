/**
 * Diagnostic model and projections for the nifra verification pipeline.
 *
 * Scanners publish frozen facts; this module turns those facts plus policy into the stable legacy and
 * structured diagnostic views. The CLI, JSON output, and MCP all consume the resulting CheckResult.
 */

import { existsSync } from "node:fs"
import { join } from "node:path"
import type { AssuranceConfig, AssuranceReport } from "@nifrajs/core/assurance"
import type { ProjectEvidenceSnapshot } from "@nifrajs/core/evidence"
import type { CapabilityProjectReport } from "./capabilities-tool.ts"
import {
  type Diagnostic,
  type DiagnosticSuggestion,
  diagnostic,
  diagnosticCompatibilityOf,
} from "./diagnostics.ts"
import type { DuplicateInstallFinding } from "./doctor.ts"
import type { PipelineReport } from "./pipeline-report.ts"
import { freezeProjectFacts, type ProjectFactsSeed } from "./project-facts.ts"
import { parseRulePacks, runRuleRegistry } from "./rules/index.ts"
import { islandRules } from "./rules/islands.ts"
import { LEGACY_RULE_CODES, LEGACY_RULE_ORDER, legacyRules } from "./rules/legacy.ts"
import { nanoRules } from "./rules/nano.ts"
import { routeRules } from "./rules/routes.ts"
import { securityRules } from "./rules/security.ts"

/** A single machine-readable check failure - the unit an agent (or CI) acts on. */
export interface CheckDiagnostic {
  readonly rule: string
  /** `error` fails the gate (a real contract break); `warning` is advisory - surfaced to the agent but
   * does NOT fail `nifra check`, for patterns that are sometimes intentional (a route returning a raw
   * `Response`, which silently drops the typed client to `data: never` but is valid for files/redirects). */
  readonly severity: "error" | "warning" | "info"
  /** Stable diagnostic protocol code. The legacy `rule` remains for compatibility. */
  readonly code?: string
  readonly file?: string
  readonly line?: number
  readonly message: string
  /** The canonical, rule-level fix - clean of the per-occurrence snippet, so an agent can apply it
   * directly. Set for the lint rules (they have one correct fix); omitted for `typecheck` (the fix is
   * specific to each type error). */
  readonly fix?: string
  /** A richer, agent-oriented fix hint. Diffs are only emitted when the edit is mechanical and local;
   * ambiguous cases give concrete steps instead of pretending the checker can safely rewrite code. */
  readonly suggestion?: CheckSuggestion
  /**
   * The import chain that pulls server-only code into the browser bundle, as display labels
   * `[routeFile, …as-written specifiers…, sink]`. Set only on `server-only-import`.
   *
   * #4.4: this is now the FULL **transitive** chain - a bounded import-resolution walk (`Bun.resolveSync`
   * from each file's dir, BFS the local module graph) follows `route → ../data → ../db → node:crypto`,
   * matching the build leak-guard's depth (`detectNodeBuiltinsInClient` in `@nifrajs/web/build`). A
   * length-2 chain (`[routeFile, specifier]`) means the route imports the sink directly. When a hop can't
   * be resolved precisely (a bare pkg, a tsconfig path alias), the walk degrades to the honest direct
   * edge rather than fabricating a deeper path - never a lie.
   */
  readonly chain?: readonly string[]
  readonly evidence?: readonly string[]
  readonly verify?: string
}

export type CheckSuggestion = DiagnosticSuggestion

/** The structured result of a full check - what `--json` prints and the `nifra_check` MCP tool returns. */
export interface CheckResult {
  readonly ok: boolean
  readonly typecheck: "pass" | "fail" | "skipped"
  /** Why `typecheck` is `"skipped"` (no tsconfig.json, typescript not installed, lints-only mode).
   * Absent when the typecheck ran. Echoed in the human report so a skip is never a dim mystery. */
  readonly typecheckNote?: string
  readonly diagnostics: readonly CheckDiagnostic[]
  /** Normalized diagnostics with stable codes for agents and external renderers. */
  readonly structuredDiagnostics?: readonly Diagnostic[]
  /**
   * Which bundler this app's phases run on, read statically from the config, and how nifra concluded
   * it. Returned even when nothing is wrong: an agent reading this project has to know which plugin
   * slot is live and which toolchain compiles a component before its next edit, and every `pipeline`
   * diagnostic below is only interpretable against it. Absent when the directory is not a nifra app.
   */
  readonly pipeline?: PipelineReport
  /** Intentional non-typed mount prefixes declared in `nifra.check.json` (e.g. `/auth` for a mounted
   * better-auth). Echoed here so `--json` / the MCP tool / the report can show what the typed-client scan
   * deliberately skipped - a suppressed prefix stays auditable instead of silently hiding real drift. */
  readonly externalMounts?: readonly string[]
  /** Active per-rule overrides from `nifra.check.json` `rules`, echoed verbatim so a retagged or
   * suppressed finding stays auditable in `--json`, the MCP tool, and the human report - config can
   * lower (or raise) the gate, but never invisibly. */
  readonly ruleOverrides?: Readonly<Record<string, RuleOverride>>
  /** Set only when the caller passed `maxDiagnostics` and there were more - `diagnostics` then holds the
   * first `shown` of `total`. It caps the serialized size so the `nifra_check` MCP tool can't emit a
   * message large enough to break the stdio transport; fix the shown diagnostics and re-run for the rest. */
  readonly truncated?: { readonly shown: number; readonly total: number }
  /**
   * The identity preflight's machine-readable result: every duplicate physical install of an
   * identity-sensitive package, with each copy's resolved absolute path, version, and the importers
   * that pulled it in. Present whenever the dependency scan ran - including when it found nothing, so
   * tooling can distinguish "clean" from "did not look". The human rendering of the same data lives in
   * the `duplicate-install` diagnostics; this field is what `--json` consumers parse instead.
   */
  readonly identityPreflight?: IdentityPreflightResult
}

/** The `identityPreflight` slice of {@link CheckResult}. */
export interface IdentityPreflightResult {
  /** Which tree the scan looked at, in the same words the build/dev preflight uses. */
  readonly basis?: string
  /** The scan stopped at the workspace-enumeration cap - "no duplicates" covers only the scanned part. */
  readonly truncated?: boolean
  /** Duplicates that fail the gate. Empty means the scanned tree is clean. */
  readonly duplicates: readonly DuplicateInstallFinding[]
  /** Duplicates covered by a `"nifra": { "singleCopy": [...] }` declaration - reported, never fatal. */
  readonly deduplicated: readonly DuplicateInstallFinding[]
}

/**
 * Pre-resolved route-assurance inputs, so the same reflection that `nifra assure` / `nifra levels`
 * already ran can feed `check`'s capability + trust-manifest diagnostics instead of a second pass.
 * Supplied by {@link collectProjectVerification}. When omitted, `collectCheckResult` loads and computes
 * these itself (the standalone `nifra_check` MCP path); the two routes produce byte-identical results.
 */
export interface CheckAssuranceContext {
  /** Whether `nifra.assurance.ts` exists: the gate for running the assurance-fed diagnostics at all. */
  readonly present: boolean
  /** The loaded config, when it loaded. Absent when the file is missing or {@link error} is set. */
  readonly config?: AssuranceConfig
  /** The failure from loading/evaluating the config, surfaced as a `capability-config` diagnostic. */
  readonly error?: unknown
  /** `evaluateRouteAssurance` over the config's source + policy (drives the trust-manifest check). */
  readonly routeAssurance?: AssuranceReport
  /** Static capability provenance, when the config declares a capabilities policy. */
  readonly capability?: CapabilityProjectReport
  /** Canonical token-only evidence reused by manifest and other offline projections. */
  readonly evidence?: ProjectEvidenceSnapshot
}

/** Optional per-project `nifra.check.json` - pure data (no code execution), so it's safe to read before
 * the app is built or even importable, preserving check's pre-`loadApp` invariant. */
export interface CheckConfig {
  readonly externalMounts: readonly string[]
  readonly rules: Readonly<Record<string, RuleOverride>>
}

/**
 * One entry of `nifra.check.json` `rules`, keyed by legacy rule name (`response-route`) or stable
 * NF- code (`NF-S002`) - one key retags the finding in both diagnostic views. `severity: "off"`
 * drops the rule's findings; `ignore` drops findings whose file matches any of the globs. Overrides
 * are applied centrally BEFORE `ok` is computed and echoed in the result and the human report -
 * configuration can lower (or raise) the gate, but never invisibly.
 */
export interface RuleOverride {
  readonly severity?: "error" | "warn" | "info" | "off"
  readonly ignore?: readonly string[]
}

const MAX_IGNORE_GLOB_LENGTH = 4096
const MAX_IGNORE_GLOB_ALTERNATIVES = 64

/**
 * Match the small file-glob language used by check overrides without compiling user input into a
 * regular expression. `nifra.check.json` is commonly supplied by a project or CI wrapper, so an
 * attacker who can influence it must not be able to turn a diagnostic filter into a ReDoS input.
 * The matcher supports the portable glob forms users expect here: `*`, `?`, `**`, character
 * classes, and brace alternatives.
 */
function safeIgnoreGlobMatch(pattern: string, file: string): boolean {
  if (pattern.length === 0 || pattern.length > MAX_IGNORE_GLOB_LENGTH) return false
  for (const alternative of expandIgnoreGlobBraces(pattern)) {
    if (matchIgnoreGlobPath(alternative, file)) return true
  }
  return false
}

function expandIgnoreGlobBraces(pattern: string): readonly string[] {
  const open = firstUnescaped(pattern, "{")
  if (open === -1) return [pattern]
  const close = matchingBrace(pattern, open)
  if (close === -1) return [pattern]
  const choices = splitBraceChoices(pattern.slice(open + 1, close))
  if (choices.length < 2) return [pattern]

  const expanded: string[] = []
  for (const choice of choices) {
    const prefix = pattern.slice(0, open) + choice + pattern.slice(close + 1)
    for (const nested of expandIgnoreGlobBraces(prefix)) {
      expanded.push(nested)
      if (expanded.length >= MAX_IGNORE_GLOB_ALTERNATIVES) return expanded
    }
  }
  return expanded
}

function firstUnescaped(value: string, needle: string): number {
  let escaped = false
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!
    if (escaped) {
      escaped = false
      continue
    }
    if (char === "\\") {
      escaped = true
      continue
    }
    if (char === needle) return index
  }
  return -1
}

function matchingBrace(value: string, open: number): number {
  let depth = 0
  let escaped = false
  for (let index = open; index < value.length; index++) {
    const char = value[index]!
    if (escaped) {
      escaped = false
      continue
    }
    if (char === "\\") {
      escaped = true
      continue
    }
    if (char === "{") depth++
    else if (char === "}" && --depth === 0) return index
  }
  return -1
}

function splitBraceChoices(value: string): readonly string[] {
  const choices: string[] = []
  let start = 0
  let depth = 0
  let escaped = false
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!
    if (escaped) {
      escaped = false
      continue
    }
    if (char === "\\") {
      escaped = true
      continue
    }
    if (char === "{") depth++
    else if (char === "}") depth--
    else if (char === "," && depth === 0) {
      choices.push(value.slice(start, index))
      start = index + 1
    }
  }
  choices.push(value.slice(start))
  return choices
}

function matchIgnoreGlobPath(pattern: string, file: string): boolean {
  const patternParts = pattern.split("/")
  const fileParts = file.split("/")
  let reachable = new Array<boolean>(fileParts.length + 1).fill(false)
  reachable[0] = true
  for (const part of patternParts) {
    const next = new Array<boolean>(fileParts.length + 1).fill(false)
    if (part === "**") {
      let canReach = false
      for (let index = 0; index <= fileParts.length; index++) {
        canReach ||= reachable[index] === true
        next[index] = canReach
      }
    } else {
      for (let index = 0; index < fileParts.length; index++) {
        if (reachable[index] && matchIgnoreGlobPart(part, fileParts[index]!)) next[index + 1] = true
      }
    }
    reachable = next
  }
  return reachable[fileParts.length] === true
}

function matchIgnoreGlobPart(pattern: string, value: string): boolean {
  let previous = new Array<boolean>(value.length + 1).fill(false)
  previous[0] = true
  for (let patternIndex = 0; patternIndex < pattern.length; patternIndex++) {
    const char = pattern[patternIndex]!
    const next = new Array<boolean>(value.length + 1).fill(false)
    if (char === "*") {
      next[0] = previous[0] === true
      for (let valueIndex = 1; valueIndex <= value.length; valueIndex++)
        next[valueIndex] = previous[valueIndex] === true || next[valueIndex - 1] === true
    } else if (char === "?") {
      for (let valueIndex = 1; valueIndex <= value.length; valueIndex++)
        next[valueIndex] = previous[valueIndex - 1] === true
    } else if (char === "\\" && patternIndex + 1 < pattern.length) {
      const literal = pattern[++patternIndex]!
      for (let valueIndex = 1; valueIndex <= value.length; valueIndex++)
        next[valueIndex] = previous[valueIndex - 1] === true && value[valueIndex - 1] === literal
    } else if (char === "[") {
      const classEnd = ignoreGlobClassEnd(pattern, patternIndex + 1)
      if (classEnd === -1)
        return matchIgnoreGlobPart(`\\[${pattern.slice(patternIndex + 1)}`, value)
      for (let valueIndex = 1; valueIndex <= value.length; valueIndex++)
        next[valueIndex] =
          previous[valueIndex - 1] === true &&
          matchIgnoreGlobClass(pattern.slice(patternIndex + 1, classEnd), value[valueIndex - 1]!)
      patternIndex = classEnd
    } else {
      for (let valueIndex = 1; valueIndex <= value.length; valueIndex++)
        next[valueIndex] = previous[valueIndex - 1] === true && value[valueIndex - 1] === char
    }
    previous = next
  }
  return previous[value.length] === true
}

function ignoreGlobClassEnd(pattern: string, start: number): number {
  for (let index = start; index < pattern.length; index++) {
    if (pattern[index] === "]" && index > start) return index
  }
  return -1
}

function matchIgnoreGlobClass(spec: string, value: string): boolean {
  let index = 0
  let negated = false
  if (spec[0] === "!" || spec[0] === "^") {
    negated = true
    index++
  }
  let matched = false
  while (index < spec.length) {
    const first = spec[index] === "\\" ? spec[++index] : spec[index]
    if (first === undefined) break
    index++
    if (spec[index] === "-" && index + 1 < spec.length) {
      index++
      const last = spec[index] === "\\" ? spec[++index] : spec[index]
      if (last !== undefined && first <= value && value <= last) matched = true
      index++
    } else if (value === first) {
      matched = true
    }
  }
  return negated ? !matched : matched
}

export interface CheckTypecheckResult {
  readonly ran: boolean
  readonly ok: boolean
  readonly note?: string
  readonly output?: string
  readonly missingTypeScript?: boolean
}

export interface CheckAnalysisInput {
  readonly facts: ProjectFactsSeed
}

export interface CheckDiagnosticsOptions {
  readonly maxDiagnostics?: number
  readonly assurance?: CheckAssuranceContext
}

export async function collectCheckDiagnostics(
  cwd: string,
  scan: CheckAnalysisInput,
  opts: CheckDiagnosticsOptions = {},
): Promise<CheckResult> {
  // The rule registry is the only diagnostic producer. This preparation phase may load executable
  // assurance configuration because rules need its reflected facts, but it never formats findings.
  let factsSeed = scan.facts
  let loadedPolicy = opts.assurance ?? factsSeed.policies.assurance
  let loadedCapability = loadedPolicy?.capability ?? factsSeed.policies.capability
  let applicationRulePacks = factsSeed.policies.rulePacks
  const assuranceConfigPath = join(cwd, "nifra.assurance.ts")

  if (loadedPolicy === undefined && existsSync(assuranceConfigPath)) {
    try {
      const { loadAssuranceConfig } = await import("./assure.ts")
      const config = await loadAssuranceConfig(cwd)
      let capability: import("./capabilities-tool.ts").CapabilityProjectReport | undefined
      if (config.capabilities !== undefined) {
        const { collectCapabilityProjectReport } = await import("./capabilities-tool.ts")
        capability = await collectCapabilityProjectReport(cwd, config.source, config.capabilities)
      }
      loadedPolicy = {
        present: true,
        config,
        ...(capability === undefined ? {} : { capability }),
      }
      loadedCapability = capability
      applicationRulePacks = parseRulePacks(config.rulePacks)
    } catch (error) {
      loadedPolicy = { present: true, error }
      loadedCapability = undefined
      applicationRulePacks = []
    }
  } else if (loadedPolicy?.present === true && loadedPolicy.error === undefined) {
    try {
      if (loadedPolicy.config === undefined) throw new Error("assurance configuration unavailable")
      applicationRulePacks = parseRulePacks(loadedPolicy.config.rulePacks)
      loadedCapability = loadedPolicy.capability ?? loadedCapability
    } catch (error) {
      loadedPolicy = { present: true, error }
      loadedCapability = undefined
      applicationRulePacks = []
    }
  }

  factsSeed = {
    ...factsSeed,
    policies: {
      ...factsSeed.policies,
      ...(loadedPolicy === undefined ? {} : { assurance: loadedPolicy }),
      ...(loadedCapability === undefined ? {} : { capability: loadedCapability }),
      rulePacks: applicationRulePacks,
    },
  }
  const projectFacts = freezeProjectFacts(factsSeed)
  const ruleContext = {
    root: cwd,
    sources: projectFacts.source,
    project: projectFacts,
  }

  const builtInRules = [
    ...legacyRules,
    ...securityRules,
    ...routeRules,
    ...islandRules,
    ...nanoRules,
  ]
  let registryDiagnostics: Diagnostic[] = []
  let builtInsSucceeded = false
  try {
    registryDiagnostics = await runRuleRegistry(ruleContext, builtInRules)
    builtInsSucceeded = true
  } catch (error) {
    registryDiagnostics = [
      diagnostic({
        code: "NF-C017",
        severity: "error",
        message:
          "rule registry failed closed: " +
          (error instanceof Error ? error.message : String(error)),
        fix: { recipe: "rule-pack.repair", command: "nifra check --lints-only" },
        verify: "nifra check --lints-only",
      }),
    ]
  }
  if (builtInsSucceeded && projectFacts.policies.rulePacks.length > 0) {
    try {
      registryDiagnostics.push(
        ...(await runRuleRegistry(ruleContext, [], projectFacts.policies.rulePacks)),
      )
    } catch (error) {
      // Keep all built-in findings when an application rule fails. The old compatibility path had
      // already materialized those findings before packs ran; preserving that property matters when
      // a broken pack must not hide a more actionable built-in failure.
      registryDiagnostics.push(
        diagnostic({
          code: "NF-C017",
          severity: "error",
          message:
            "rule registry failed closed: " +
            (error instanceof Error ? error.message : String(error)),
          fix: { recipe: "rule-pack.repair", command: "nifra check --lints-only" },
          verify: "nifra check --lints-only",
        }),
      )
    }
  }

  const knownLegacyCodes = new Set(Object.values(LEGACY_RULE_CODES))
  const compatibilityRows: CheckDiagnostic[] = []
  for (const item of registryDiagnostics) {
    const compatibility = diagnosticCompatibilityOf(item)
    if (compatibility !== undefined) {
      compatibilityRows.push({
        rule: compatibility.rule,
        severity: item.severity === "warn" ? "warning" : item.severity,
        ...(compatibility.includeCode === true ? { code: item.code } : {}),
        ...(item.file === undefined ? {} : { file: item.file }),
        ...(item.line === undefined ? {} : { line: item.line }),
        message: item.message,
        ...(compatibility.fix === undefined ? {} : { fix: compatibility.fix }),
        // A legacy chain was a separate field; canonical diagnostics expose the same values as
        // evidence for structured consumers, so do not leak that projection back into the old view.
        ...(item.evidence === undefined || compatibility.chain !== undefined
          ? {}
          : { evidence: item.evidence }),
        ...(compatibility.chain === undefined ? {} : { chain: compatibility.chain }),
        ...(compatibility.suggestion === undefined ? {} : { suggestion: compatibility.suggestion }),
        ...(item.verify === undefined ? {} : { verify: item.verify }),
      })
      continue
    }
    // A structured informational contract note intentionally has no old human/legacy row. Every
    // other non-legacy rule (security, route, island, nano, or an application pack) retains the
    // existing fallback row keyed by its stable code.
    if (knownLegacyCodes.has(item.code)) continue
    compatibilityRows.push({
      rule: item.code,
      severity: item.severity === "error" ? "error" : "warning",
      code: item.code,
      ...(item.file === undefined ? {} : { file: item.file }),
      ...(item.line === undefined ? {} : { line: item.line }),
      message: item.message,
      ...(item.evidence === undefined ? {} : { evidence: item.evidence }),
      ...(item.verify === undefined ? {} : { verify: item.verify }),
    })
  }

  // Keep the old compatibility order stable even though the canonical registry order is explicit.
  const order = new Map(LEGACY_RULE_ORDER.map((rule, index) => [rule, index]))
  const orderedLegacy = compatibilityRows
    .map((value, index) => ({ value, index }))
    .sort(
      (a, b) =>
        (order.get(a.value.rule) ?? LEGACY_RULE_ORDER.length) -
          (order.get(b.value.rule) ?? LEGACY_RULE_ORDER.length) || a.index - b.index,
    )
    .map((entry) => entry.value)

  const checkConfig = projectFacts.policies.checkConfig
  const overrideFor = (...keys: (string | undefined)[]): RuleOverride | undefined => {
    for (const key of keys) {
      if (key !== undefined && checkConfig.rules[key] !== undefined) return checkConfig.rules[key]
    }
    return undefined
  }
  const dropped = (override: RuleOverride, file: string | undefined): boolean => {
    if (override.severity === "off") return true
    if (override.ignore === undefined || file === undefined) return false
    return override.ignore.some((pattern) => safeIgnoreGlobMatch(pattern, file))
  }
  const codeToLegacy = new Map(
    Object.entries(LEGACY_RULE_CODES).map(([name, code]) => [code, name]),
  )
  const finalDiagnostics = orderedLegacy.flatMap<CheckDiagnostic>((value) => {
    const override = overrideFor(value.rule, value.code, LEGACY_RULE_CODES[value.rule])
    if (override === undefined) return [value]
    if (dropped(override, value.file)) return []
    if (override.severity === undefined || override.severity === "off") return [value]
    return [{ ...value, severity: override.severity === "warn" ? "warning" : override.severity }]
  })

  const structuredExtras = registryDiagnostics.filter(
    (value) => diagnosticCompatibilityOf(value) === undefined && knownLegacyCodes.has(value.code),
  )
  const structuredDiagnostics = [
    ...structuredExtras,
    ...registryDiagnostics.filter((value) => !structuredExtras.includes(value)),
  ]
  const finalStructured = structuredDiagnostics.flatMap<Diagnostic>((value) => {
    const override = overrideFor(value.code, codeToLegacy.get(value.code))
    if (override === undefined) return [value]
    if (dropped(override, value.file)) return []
    if (override.severity === undefined || override.severity === "off") return [value]
    return [Object.freeze({ ...value, severity: override.severity })]
  })

  const total = finalDiagnostics.length
  const max = opts.maxDiagnostics
  const shown = max !== undefined && total > max ? finalDiagnostics.slice(0, max) : finalDiagnostics
  const nonLegacyStructuredCount = finalStructured.filter(
    (value) => knownLegacyCodes.has(value.code) && diagnosticCompatibilityOf(value) === undefined,
  ).length
  const structuredLimit =
    shown.length < total ? shown.length + nonLegacyStructuredCount : finalStructured.length

  const doctor = projectFacts.packages.doctor
  const result: CheckResult = {
    ok: !finalDiagnostics.some((value) => value.severity === "error"),
    typecheck: projectFacts.check.typecheck.ran
      ? projectFacts.check.typecheck.ok
        ? "pass"
        : "fail"
      : "skipped",
    ...(!projectFacts.check.typecheck.ran && projectFacts.check.typecheck.note !== undefined
      ? { typecheckNote: projectFacts.check.typecheck.note }
      : {}),
    diagnostics: shown,
    ...(projectFacts.pipeline !== undefined ? { pipeline: projectFacts.pipeline } : {}),
    ...(doctor.ran
      ? {
          identityPreflight: {
            ...(doctor.identityBasis === undefined ? {} : { basis: doctor.identityBasis }),
            ...(doctor.identityScanTruncated === true ? { truncated: true } : {}),
            duplicates: doctor.duplicateInstalls,
            deduplicated: doctor.deduplicatedInstalls ?? [],
          },
        }
      : {}),
    ...(checkConfig.externalMounts.length === 0
      ? {}
      : { externalMounts: checkConfig.externalMounts }),
    ...(Object.keys(checkConfig.rules).length === 0 ? {} : { ruleOverrides: checkConfig.rules }),
    ...(shown.length < total ? { truncated: { shown: shown.length, total } } : {}),
  }
  Object.defineProperty(result, "structuredDiagnostics", {
    value: finalStructured.slice(0, structuredLimit),
    enumerable: false,
  })
  return result
}
