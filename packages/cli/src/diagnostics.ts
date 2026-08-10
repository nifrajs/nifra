/** Stable, machine-actionable diagnostics shared by CLI gates and MCP renderers. */

export type Severity = "error" | "warn" | "info"

export interface DiagnosticFix {
  readonly recipe: string
  readonly command?: string
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

export const diagnostic = (value: Diagnostic): Diagnostic => Object.freeze(value)

export function severityFails(severity: Severity, strict = false): boolean {
  return severity === "error" || (strict && severity === "warn")
}

export function normalizeSeverity(value: "error" | "warning" | "warn" | "info"): Severity {
  return value === "warning" ? "warn" : value
}
