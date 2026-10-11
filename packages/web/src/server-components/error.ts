export const COMPONENT_ERROR_CODES = [
  "component_contract",
  "component_input",
  "component_protocol",
  "component_limit",
  "component_denied",
  "component_unavailable",
  "component_version",
  "component_busy",
  "component_timeout",
  "component_failed",
  "component_cancelled",
] as const
export type ComponentErrorCode = (typeof COMPONENT_ERROR_CODES)[number]

export class ServerComponentError extends Error {
  override readonly name = "ServerComponentError"
  constructor(
    readonly code: ComponentErrorCode,
    readonly status: number = 500,
  ) {
    super(`[nifra/web] ${code}`)
  }
}
