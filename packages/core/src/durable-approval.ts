import type { CapabilityApprovalGate } from "./internal/capability-runtime.ts"
import { durableApprovalProtocol } from "./internal/durable-approval-protocol.ts"
import {
  addDuration,
  assertPositiveMs,
  assertToken,
  bytesToBase64Url,
  cloneValue,
  encoder,
  readClock,
  sha256,
} from "./internal/durable-shared.ts"
import type {
  ApprovalConsumeResult,
  ApprovalRecord,
  ApprovalStore,
} from "./internal/durable-types.ts"

const decoder = new TextDecoder()

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new ApprovalTokenInvalidError()
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=")
  let binary: string
  try {
    binary = atob(padded)
  } catch {
    throw new ApprovalTokenInvalidError()
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}
// Durable human approval with signed, single-use resume tokens

export class ApprovalRequiredError extends Error {
  readonly approvalId: string
  readonly effectId: string
  readonly resumeToken!: string
  readonly expiresAt: number

  constructor(approvalId: string, effectId: string, resumeToken: string, expiresAt: number) {
    super("capability approval is required")
    this.approvalId = approvalId
    this.effectId = effectId
    this.expiresAt = expiresAt
    Object.defineProperty(this, "resumeToken", {
      value: resumeToken,
      enumerable: false,
      configurable: false,
      writable: false,
    })
    this.name = "ApprovalRequiredError"
  }
}

export class ApprovalTokenInvalidError extends Error {
  constructor() {
    super("approval resume token is invalid")
    this.name = "ApprovalTokenInvalidError"
  }
}
export class ApprovalTokenExpiredError extends Error {
  constructor() {
    super("approval resume token has expired")
    this.name = "ApprovalTokenExpiredError"
  }
}
export class ApprovalTokenReplayError extends Error {
  constructor() {
    super("approval resume token has already been consumed")
    this.name = "ApprovalTokenReplayError"
  }
}
export class ApprovalBindingError extends Error {
  constructor() {
    super("approval resume token is bound to another tenant or principal")
    this.name = "ApprovalBindingError"
  }
}
export class ApprovalPendingError extends Error {
  constructor() {
    super("capability approval is still pending")
    this.name = "ApprovalPendingError"
  }
}
export class ApprovalDeniedError extends Error {
  constructor() {
    super("capability approval was denied")
    this.name = "ApprovalDeniedError"
  }
}

interface ResumeClaims {
  readonly v: 1
  readonly id: string
  readonly nonce: string
  readonly exp: number
}

export interface ApprovalCoordinator extends CapabilityApprovalGate {
  decide(input: {
    readonly approvalId: string
    readonly tenantId: string
    readonly decision: "approved" | "denied"
    readonly decidedBy: string
  }): Promise<void>
  get(approvalId: string): Promise<ApprovalRecord | undefined>
}

export interface ApprovalCoordinatorOptions {
  readonly store: ApprovalStore
  /** At least 32 random bytes, kept separately from the approval store. */
  readonly secret: Uint8Array
  readonly ttlMs?: number
  readonly now?: () => number
  /** Tests/local development only. Production approval records require a durable store. */
  readonly allowMemoryStore?: boolean
}

export function createApprovalCoordinator(
  options: ApprovalCoordinatorOptions,
): ApprovalCoordinator {
  if (options.store.durability !== "durable" && options.allowMemoryStore !== true) {
    throw new TypeError('approval coordinator requires store.durability === "durable"')
  }
  if (!(options.secret instanceof Uint8Array) || options.secret.byteLength < 32) {
    throw new TypeError("approval secret must contain at least 32 random bytes")
  }
  const secret = new Uint8Array(options.secret)
  const ttlMs = options.ttlMs ?? 15 * 60_000
  assertPositiveMs(ttlMs, "approval ttlMs")
  const clock = options.now ?? Date.now
  const now = (): number => readClock(clock, "approval clock")
  const key = crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ])

  const sign = async (claims: ResumeClaims): Promise<string> => {
    const payload = bytesToBase64Url(encoder.encode(JSON.stringify(claims)))
    const signature = new Uint8Array(
      await crypto.subtle.sign("HMAC", await key, encoder.encode(payload)),
    )
    return `v1.${payload}.${bytesToBase64Url(signature)}`
  }
  const verify = async (token: string): Promise<ResumeClaims> => {
    if (typeof token !== "string" || token.length > 2048) throw new ApprovalTokenInvalidError()
    const parts = token.split(".")
    if (parts.length !== 3 || parts[0] !== "v1") throw new ApprovalTokenInvalidError()
    const payload = parts[1] as string
    const valid = await crypto.subtle.verify(
      "HMAC",
      await key,
      base64UrlToBytes(parts[2] as string).buffer as ArrayBuffer,
      encoder.encode(payload),
    )
    if (!valid) throw new ApprovalTokenInvalidError()
    let claims: unknown
    try {
      claims = JSON.parse(decoder.decode(base64UrlToBytes(payload)))
    } catch {
      throw new ApprovalTokenInvalidError()
    }
    if (typeof claims !== "object" || claims === null) throw new ApprovalTokenInvalidError()
    const candidate = claims as Partial<ResumeClaims>
    if (
      candidate.v !== 1 ||
      typeof candidate.id !== "string" ||
      typeof candidate.nonce !== "string" ||
      !Number.isSafeInteger(candidate.exp)
    ) {
      throw new ApprovalTokenInvalidError()
    }
    assertToken(candidate.id, "approval id", 128)
    assertToken(candidate.nonce, "approval nonce", 128)
    if ((candidate.exp as number) <= now()) throw new ApprovalTokenExpiredError()
    return candidate as ResumeClaims
  }

  const coordinator: ApprovalCoordinator = {
    async authorize(input: Parameters<CapabilityApprovalGate["authorize"]>[0]) {
      if (input.signal.aborted) throw input.signal.reason
      assertToken(input.identity.tenantId, "approval tenantId")
      assertToken(input.identity.principalId, "approval principalId")
      if (input.resumeToken === undefined) {
        const approvalId = crypto.randomUUID()
        const nonce = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(18)))
        const issuedAt = now()
        const expiresAt = addDuration(issuedAt, ttlMs, "approval expiry")
        const resumeToken = await sign({ v: 1, id: approvalId, nonce, exp: expiresAt })
        const accepted = await options.store.create(
          Object.freeze({
            approvalId,
            effectId: input.effectId,
            capability: input.capability,
            ...(input.target === undefined ? {} : { target: input.target }),
            ...(input.digest === undefined ? {} : { digest: input.digest }),
            tenantId: input.identity.tenantId,
            principalId: input.identity.principalId,
            tokenHash: await sha256(resumeToken),
            state: "pending" as const,
            createdAt: issuedAt,
            expiresAt,
            updatedAt: issuedAt,
            version: 1,
          }),
        )
        if (!accepted) throw new Error("approval store rejected a unique approval id")
        throw new ApprovalRequiredError(approvalId, input.effectId, resumeToken, expiresAt)
      }
      const claims = await verify(input.resumeToken)
      const consumed = await options.store.consume({
        approvalId: claims.id,
        tenantId: input.identity.tenantId,
        principalId: input.identity.principalId,
        capability: input.capability,
        ...(input.target === undefined ? {} : { target: input.target }),
        ...(input.digest === undefined ? {} : { digest: input.digest }),
        tokenHash: await sha256(input.resumeToken),
        now: now(),
      })
      if (consumed.state === "consumed") return
      if (consumed.state === "replay") throw new ApprovalTokenReplayError()
      if (consumed.state === "binding") throw new ApprovalBindingError()
      if (consumed.state === "expired") throw new ApprovalTokenExpiredError()
      if (consumed.state === "pending") throw new ApprovalPendingError()
      if (consumed.state === "denied") throw new ApprovalDeniedError()
      throw new ApprovalTokenInvalidError()
    },
    async decide(input: Parameters<ApprovalCoordinator["decide"]>[0]) {
      assertToken(input.approvalId, "approval id", 128)
      assertToken(input.tenantId, "approval tenantId")
      assertToken(input.decidedBy, "approval decidedBy")
      const accepted = await options.store.decide({ ...input, now: now() })
      if (!accepted) throw new Error("approval decision rejected")
    },
    async get(approvalId: string) {
      assertToken(approvalId, "approval id", 128)
      return await options.store.get(approvalId)
    },
  }
  return Object.freeze(coordinator)
}

export class MemoryApprovalStore implements ApprovalStore {
  readonly durability = "memory" as const
  private readonly records = new Map<string, ApprovalRecord>()

  create(record: ApprovalRecord): boolean {
    if (this.records.has(record.approvalId)) return false
    this.records.set(record.approvalId, Object.freeze(cloneValue(record)))
    return true
  }
  get(approvalId: string): ApprovalRecord | undefined {
    const record = this.records.get(approvalId)
    return record === undefined ? undefined : Object.freeze(cloneValue(record))
  }
  decide(input: Parameters<ApprovalStore["decide"]>[0]): boolean {
    const record = this.records.get(input.approvalId)
    const next = durableApprovalProtocol.decide(record, input)
    if (next === undefined) return false
    this.records.set(input.approvalId, Object.freeze(next))
    return true
  }
  consume(input: Parameters<ApprovalStore["consume"]>[0]): ApprovalConsumeResult {
    const record = this.records.get(input.approvalId)
    const transition = durableApprovalProtocol.consume(record, input)
    if (transition.next !== undefined)
      this.records.set(input.approvalId, Object.freeze(transition.next))
    return transition.result
  }
  list(): readonly ApprovalRecord[] {
    return Object.freeze(
      [...this.records.values()].map((record) => Object.freeze(cloneValue(record))),
    )
  }
}

// -------------------------------------------------------------------------------------------------
