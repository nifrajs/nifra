/**
 * Small, backend-neutral capability manifest.
 *
 * The manifest is deliberately descriptive: an operator still decides which capabilities are
 * trusted, and implementations remain free to enforce them with a sandbox, OS policy, or approval
 * broker. Keeping this seam in the optional agent package avoids putting process/filesystem policy
 * into Nifra's framework runtime.
 */
export const AGENT_CAPABILITY_MANIFEST_VERSION = 1 as const

export type AgentCapability =
  | "filesystem.read"
  | "filesystem.write"
  | "process.exec"
  | "network.request"
  | "credentials.read"

export interface AgentCapabilityManifest {
  readonly version: typeof AGENT_CAPABILITY_MANIFEST_VERSION
  readonly requested: readonly AgentCapability[]
  readonly trusted: readonly AgentCapability[]
  readonly reason?: string
}

export function createCapabilityManifest(
  requested: readonly AgentCapability[],
  trusted: readonly AgentCapability[] = [],
  reason?: string,
): AgentCapabilityManifest {
  const unique = (values: readonly AgentCapability[]): readonly AgentCapability[] =>
    Object.freeze([...new Set(values)])
  return Object.freeze({
    version: AGENT_CAPABILITY_MANIFEST_VERSION,
    requested: unique(requested),
    trusted: unique(trusted),
    ...(reason === undefined ? {} : { reason: reason.slice(0, 512) }),
  })
}

export function deniedCapabilities(manifest: AgentCapabilityManifest): readonly AgentCapability[] {
  const trusted = new Set(manifest.trusted)
  return Object.freeze(manifest.requested.filter((capability) => !trusted.has(capability)))
}

export function parseCapabilityManifest(value: unknown): AgentCapabilityManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("capability manifest must be an object")
  const record = value as Record<string, unknown>
  if (record.version !== AGENT_CAPABILITY_MANIFEST_VERSION)
    throw new TypeError("unsupported capability manifest version")
  const requested = parseCapabilities(record.requested, "requested")
  const trusted = parseCapabilities(record.trusted, "trusted")
  if (record.reason !== undefined && typeof record.reason !== "string")
    throw new TypeError("capability manifest reason must be a string")
  return createCapabilityManifest(
    requested,
    trusted,
    typeof record.reason === "string" ? record.reason : undefined,
  )
}

function parseCapabilities(value: unknown, name: string): readonly AgentCapability[] {
  if (!Array.isArray(value)) throw new TypeError(`capability manifest ${name} must be an array`)
  const allowed = new Set<AgentCapability>([
    "filesystem.read",
    "filesystem.write",
    "process.exec",
    "network.request",
    "credentials.read",
  ])
  if (value.some((item) => typeof item !== "string" || !allowed.has(item as AgentCapability)))
    throw new TypeError(`capability manifest ${name} contains an unknown capability`)
  return value as AgentCapability[]
}
