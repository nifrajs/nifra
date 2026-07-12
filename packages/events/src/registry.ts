/**
 * A registry of event contracts keyed by `type@version`. Give it the contracts a boundary accepts,
 * hand it untrusted input (an SSE frame, a queue message, a webhook body), and it dispatches to the
 * matching contract and parses — or fails closed when no contract owns that `type@version`.
 */

import type { EventContract, EventEnvelope } from "./contract.ts"

export type RegistryParseResult =
  | { readonly success: true; readonly envelope: EventEnvelope; readonly contract: EventContract }
  | {
      readonly success: false
      readonly reason: "not-an-object" | "unknown-contract" | "invalid-payload"
      readonly message: string
    }

export interface EventRegistry {
  readonly contracts: readonly EventContract[]
  /** Look up a contract by type + version (defaults to version 0). */
  get(type: string, version?: number): EventContract | undefined
  /** Dispatch untrusted input to its contract by `type`/`version` and parse. Never throws. */
  parse(input: unknown): RegistryParseResult
}

const keyOf = (type: string, version: number): string => `${type}@${version}`

/** Build a registry from a set of contracts. Throws on a duplicate `type@version`. */
export function createEventRegistry(contracts: readonly EventContract[]): EventRegistry {
  const byKey = new Map<string, EventContract>()
  for (const contract of contracts) {
    const key = keyOf(contract.type, contract.version)
    if (byKey.has(key)) {
      throw new Error(`createEventRegistry: duplicate contract ${key}`)
    }
    byKey.set(key, contract)
  }
  const frozen = Object.freeze([...contracts])

  return {
    contracts: frozen,
    get(type: string, version = 0): EventContract | undefined {
      return byKey.get(keyOf(type, version))
    },
    parse(input: unknown): RegistryParseResult {
      if (typeof input !== "object" || input === null) {
        return {
          success: false,
          reason: "not-an-object",
          message: "event envelope must be an object",
        }
      }
      const env = input as Record<string, unknown>
      const type = typeof env.type === "string" ? env.type : ""
      const version = typeof env.version === "number" ? env.version : 0
      const contract = byKey.get(keyOf(type, version))
      if (!contract) {
        return {
          success: false,
          reason: "unknown-contract",
          message: `no contract registered for ${keyOf(type, version)}`,
        }
      }
      const result = contract.parse(input)
      if (!result.success) {
        return {
          success: false,
          reason: "invalid-payload",
          message: result.issues[0]?.message ?? "payload failed validation",
        }
      }
      return { success: true, envelope: result.envelope, contract }
    },
  }
}
