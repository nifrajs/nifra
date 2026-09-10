/** Stable, machine-actionable diagnostics shared by CLI gates and MCP renderers. */

export type Severity = "error" | "warn" | "info"

export interface DiagnosticFix {
  readonly recipe: string
  readonly command?: string
}

/**
 * The richer compatibility view used by the original `nifra check` renderer. It is deliberately
 * kept out of the enumerable diagnostic shape: SARIF, MCP structured output, and JSON consumers get
 * the small stable diagnostic contract, while the legacy text view can still explain an exact edit.
 */
export interface DiagnosticCompatibility {
  /** The pre-registry rule name used by the human/legacy check result. */
  readonly rule: string
  /** The old human-facing fix text, when the rule had one. */
  readonly fix?: string
  /** A richer legacy suggestion (diff, command, or manual steps). */
  readonly suggestion?: DiagnosticSuggestion
  /** The import path evidence used by the legacy server-only-import view. */
  readonly chain?: readonly string[]
  /** Preserve the old optional `CheckDiagnostic.code` field exactly where it existed. */
  readonly includeCode?: boolean
}

export interface DiagnosticSuggestion {
  readonly kind: "edit" | "command" | "manual"
  readonly title: string
  readonly diff?: string
  readonly command?: readonly string[]
  readonly steps?: readonly string[]
}

export interface Diagnostic {
  /** Stable forever. Never renumber or reuse. */
  readonly code: string
  readonly severity: Severity
  readonly message: string
  readonly file?: string
  readonly line?: number
  /** Short evidence strings that help an agent act without exposing payloads. */
  readonly evidence?: readonly string[]
  readonly fix?: DiagnosticFix
  /** Command that proves the fix worked. */
  readonly verify?: string
}

const DIAGNOSTIC_COMPATIBILITY = Symbol("nifra.diagnosticCompatibility")

/** Attach legacy-only rendering metadata without widening the serialized diagnostic protocol. */
export function diagnosticWithCompatibility(
  value: Diagnostic,
  compatibility: DiagnosticCompatibility,
): Diagnostic {
  const result = { ...value }
  Object.defineProperty(result, DIAGNOSTIC_COMPATIBILITY, {
    value: Object.freeze({
      ...compatibility,
      ...(compatibility.chain === undefined
        ? {}
        : { chain: Object.freeze([...compatibility.chain]) }),
    }),
    enumerable: false,
  })
  return Object.freeze(result)
}

/** Read legacy-only rendering metadata. Undefined means the diagnostic has no compatibility view. */
export function diagnosticCompatibilityOf(value: Diagnostic): DiagnosticCompatibility | undefined {
  return (
    value as Diagnostic & {
      readonly [DIAGNOSTIC_COMPATIBILITY]?: DiagnosticCompatibility
    }
  )[DIAGNOSTIC_COMPATIBILITY]
}

/** The subset of SARIF 2.1.0 emitted by {@link toSarifLog}. */
export interface SarifLog {
  readonly $schema: "https://json.schemastore.org/sarif-2.1.0.json"
  readonly version: "2.1.0"
  readonly runs: readonly SarifRun[]
}

export interface SarifRun {
  readonly tool: {
    readonly driver: {
      readonly name: string
      readonly version?: string
      readonly rules: readonly SarifRule[]
    }
  }
  readonly results: readonly SarifResult[]
}

export interface SarifRule {
  readonly id: string
  readonly shortDescription: { readonly text: string }
}

export interface SarifResult {
  readonly ruleId: string
  readonly level: "error" | "warning" | "note"
  readonly message: { readonly text: string }
  readonly locations?: readonly SarifLocation[]
  readonly properties?: Readonly<Record<string, string | readonly string[]>>
}

export interface SarifLocation {
  readonly physicalLocation: {
    readonly artifactLocation: {
      readonly uri: string
      readonly uriBaseId?: string
    }
    readonly region?: { readonly startLine: number }
  }
}

export interface SarifProjectionOptions {
  /** Name shown by external review tools in the SARIF run metadata. Defaults to `nifra`. */
  readonly toolName?: string
  /** Optional CLI/framework version shown by external review tools. */
  readonly toolVersion?: string
  /** Base URI identifier for relative diagnostic file paths. */
  readonly uriBaseId?: string
}

function sarifLevel(severity: Severity): SarifResult["level"] {
  return severity === "error" ? "error" : severity === "warn" ? "warning" : "note"
}

function sarifProperties(
  value: Diagnostic,
): Readonly<Record<string, string | readonly string[]>> | undefined {
  const properties: Record<string, string | readonly string[]> = {}
  if (value.evidence !== undefined && value.evidence.length > 0)
    properties["nifra.evidence"] = [...value.evidence]
  if (value.verify !== undefined) properties["nifra.verify"] = value.verify
  if (value.fix !== undefined) {
    properties["nifra.fix.recipe"] = value.fix.recipe
    if (value.fix.command !== undefined) properties["nifra.fix.command"] = value.fix.command
  }
  return Object.keys(properties).length === 0 ? undefined : properties
}

/**
 * Project stable Nifra diagnostics into SARIF for code-host and external review surfaces.
 *
 * This is deliberately a pure projection: it does not run checks, read files, or reinterpret policy.
 * Relative file names remain relative so callers can choose the review tool's checkout base through
 * {@link SarifProjectionOptions.uriBaseId}.
 */
export function toSarifLog(
  diagnostics: readonly Diagnostic[],
  options: SarifProjectionOptions = {},
): SarifLog {
  const rules = new Map<string, SarifRule>()
  const results: SarifResult[] = []
  for (const value of diagnostics) {
    if (!rules.has(value.code)) {
      rules.set(value.code, {
        id: value.code,
        shortDescription: { text: value.message },
      })
    }
    const location =
      value.file === undefined
        ? undefined
        : {
            physicalLocation: {
              artifactLocation: {
                uri: value.file.replaceAll("\\", "/"),
                ...(options.uriBaseId === undefined ? {} : { uriBaseId: options.uriBaseId }),
              },
              ...(value.line !== undefined && Number.isInteger(value.line) && value.line >= 1
                ? { region: { startLine: value.line } }
                : {}),
            },
          }
    const properties = sarifProperties(value)
    results.push({
      ruleId: value.code,
      level: sarifLevel(value.severity),
      message: { text: value.message },
      ...(location === undefined ? {} : { locations: [location] }),
      ...(properties === undefined ? {} : { properties }),
    })
  }

  const driver = {
    name: options.toolName ?? "nifra",
    ...(options.toolVersion === undefined ? {} : { version: options.toolVersion }),
    rules: [...rules.values()],
  }
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [{ tool: { driver }, results }],
  }
}

export const diagnostic = (value: Diagnostic): Diagnostic => Object.freeze(value)

export function severityFails(severity: Severity, strict = false): boolean {
  return severity === "error" || (strict && severity === "warn")
}

export function normalizeSeverity(value: "error" | "warning" | "warn" | "info"): Severity {
  return value === "warning" ? "warn" : value
}
