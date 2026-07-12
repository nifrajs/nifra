/**
 * Portable, versioned event contracts. A contract is the *shape* of an event — a typed, versioned
 * envelope validated by any Standard Schema — decoupled from how it is delivered. Producers build
 * validated envelopes; consumers parse untrusted input against the contract before acting. The
 * transport (queue, SSE, webhook, an outbox relay) is somebody else's concern.
 */

import {
  type InferInput,
  type InferOutput,
  type StandardIssue,
  type StandardSchemaV1,
  validateStandard,
} from "@nifrajs/core"

/** The portable wire shape: identity + versioned type + timestamp + validated payload. */
export interface EventEnvelope<Payload = unknown> {
  /** Unique event id (`evt_<uuid>`), stable across redeliveries. */
  readonly id: string
  /** Event type name, e.g. `order.paid`. */
  readonly type: string
  /** Contract version. Bump on a breaking payload change; old + new versions coexist in a registry. */
  readonly version: number
  /** ISO-8601 instant the event occurred. */
  readonly occurredAt: string
  readonly payload: Payload
}

/** Thrown by {@link EventContract.create} when the payload fails the contract schema. */
export class EventContractError extends Error {
  readonly type: string
  readonly version: number
  readonly issues: readonly StandardIssue[]
  constructor(type: string, version: number, issues: readonly StandardIssue[]) {
    super(
      `event contract ${type}@${version}: payload failed validation` +
        (issues[0]?.message ? ` — ${issues[0].message}` : ""),
    )
    this.name = "EventContractError"
    this.type = type
    this.version = version
    this.issues = issues
  }
}

export type EventParseResult<Payload> =
  | { readonly success: true; readonly envelope: EventEnvelope<Payload> }
  | { readonly success: false; readonly issues: readonly StandardIssue[] }

export interface EventContract<Schema extends StandardSchemaV1 = StandardSchemaV1> {
  readonly type: string
  readonly version: number
  readonly payload: Schema
  /**
   * Validate a payload and stamp a full envelope (`id`, `occurredAt`). Throws {@link EventContractError}
   * on an invalid payload. Sync validators only — an async schema throws (use a sync payload schema for
   * events; the whole point is a cheap boundary check).
   */
  create(
    payload: InferInput<Schema>,
    options?: { id?: string; occurredAt?: string },
  ): EventEnvelope<InferOutput<Schema>>
  /** Parse untrusted input against this exact contract (type + version + payload). Never throws. */
  parse(input: unknown): EventParseResult<InferOutput<Schema>>
  /** Boolean guard form of {@link parse}. */
  is(input: unknown): input is EventEnvelope<InferOutput<Schema>>
}

const TYPE_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/

function newId(): string {
  // Web Crypto — available on Bun, Node, Deno, and edge runtimes (nifra targets the edge).
  return `evt_${globalThis.crypto.randomUUID()}`
}

function structuralIssue(message: string, key?: string): StandardIssue {
  return key === undefined ? { message } : { message, path: [key] }
}

/** Define a portable, versioned event contract. */
export function defineEventContract<Schema extends StandardSchemaV1>(spec: {
  type: string
  version: number
  payload: Schema
}): EventContract<Schema> {
  const { type, version, payload } = spec
  if (typeof type !== "string" || !TYPE_RE.test(type)) {
    throw new Error(
      `defineEventContract: invalid type ${JSON.stringify(type)} (lowercase dot/dash/underscore segments)`,
    )
  }
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(`defineEventContract: version must be a non-negative integer, got ${version}`)
  }

  function validateSync(value: unknown): { ok: true; value: InferOutput<Schema> } | { ok: false; issues: readonly StandardIssue[] } {
    const outcome = validateStandard(payload, value)
    if (outcome instanceof Promise) {
      throw new Error(
        `event contract ${type}@${version}: async payload schemas are not supported — use a sync schema`,
      )
    }
    return outcome.ok
      ? { ok: true, value: outcome.value as InferOutput<Schema> }
      : { ok: false, issues: outcome.issues }
  }

  return {
    type,
    version,
    payload,
    create(input, options): EventEnvelope<InferOutput<Schema>> {
      const validated = validateSync(input)
      if (!validated.ok) throw new EventContractError(type, version, validated.issues)
      return Object.freeze({
        id: options?.id ?? newId(),
        type,
        version,
        occurredAt: options?.occurredAt ?? new Date().toISOString(),
        payload: validated.value,
      })
    },
    parse(input): EventParseResult<InferOutput<Schema>> {
      if (typeof input !== "object" || input === null) {
        return { success: false, issues: [structuralIssue("event envelope must be an object")] }
      }
      const env = input as Record<string, unknown>
      const issues: StandardIssue[] = []
      if (typeof env.id !== "string" || env.id === "") issues.push(structuralIssue("missing id", "id"))
      if (env.type !== type) {
        issues.push(structuralIssue(`type must be ${JSON.stringify(type)}, got ${JSON.stringify(env.type)}`, "type"))
      }
      if (env.version !== version) {
        issues.push(structuralIssue(`version must be ${version}, got ${JSON.stringify(env.version)}`, "version"))
      }
      if (typeof env.occurredAt !== "string" || Number.isNaN(Date.parse(env.occurredAt))) {
        issues.push(structuralIssue("occurredAt must be an ISO-8601 string", "occurredAt"))
      }
      if (issues.length > 0) return { success: false, issues }

      const validated = validateSync(env.payload)
      if (!validated.ok) {
        // Re-root payload issues under `payload` for a caller-friendly path.
        return {
          success: false,
          issues: validated.issues.map((issue) => ({
            message: issue.message,
            path: ["payload", ...(issue.path ?? [])],
          })),
        }
      }
      return {
        success: true,
        envelope: {
          id: env.id as string,
          type,
          version,
          occurredAt: env.occurredAt as string,
          payload: validated.value,
        },
      }
    },
    is(input): input is EventEnvelope<InferOutput<Schema>> {
      return this.parse(input).success
    },
  }
}
