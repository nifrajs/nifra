export const CAPABILITY_GUARD = Symbol("nifra.capability.guard")
const CAPABILITY_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/

export function validCapabilityId(value: string): boolean {
  return CAPABILITY_ID.test(value)
}

export interface CapabilityUseEvent {
  readonly capability: string
  readonly method: string
  readonly path: string
}

export interface CapabilityGuard {
  readonly allowed: readonly string[]
  readonly method: string
  readonly path: string
  readonly onUse?: (event: CapabilityUseEvent) => void
}

export function normalizeRouteCapabilities(
  values: readonly string[] | undefined,
): readonly string[] {
  if (values === undefined) return Object.freeze([])
  if (!Array.isArray(values)) throw new TypeError("route capabilities must be an array")
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (typeof value !== "string" || !validCapabilityId(value)) {
      throw new Error(
        `route capabilities: invalid capability id ${JSON.stringify(value)} (use lowercase dot/dash segments)`,
      )
    }
    if (!seen.has(value)) {
      seen.add(value)
      out.push(value)
    }
  }
  return Object.freeze(out)
}

export function createCapabilityGuard(
  allowed: readonly string[],
  method: string,
  path: string,
  onUse: ((event: CapabilityUseEvent) => void) | undefined,
): CapabilityGuard {
  return Object.freeze({ allowed, method, path, ...(onUse !== undefined ? { onUse } : {}) })
}
