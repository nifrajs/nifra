/**
 * Orchestration value contracts: declarative run plans, content-free run evidence, artifact
 * references, and the effect-key identity. Additive to the session protocol; carries no behavior,
 * no runtime dependency, and - by construction - no payload content.
 *
 * The privacy invariant lives in the parsers here: {@link parseRunEvidence} and
 * {@link parseArtifactRef} accept only the declared content-free keys and reject any record over
 * {@link EVIDENCE_MAX_BYTES}. A prompt, model output, or tool payload cannot round-trip through
 * these contracts. Raw payloads travel only through an {@link ArtifactPort} the caller owns.
 */

/** Orchestration contract version. Additive to the session `AGENT_PROTOCOL_VERSION`. */
export const RUN_PLAN_VERSION = 1 as const

/** Hard cap on a single serialized evidence record. A content-free record never approaches this. */
export const EVIDENCE_MAX_BYTES = 4096

/**
 * Keys that would carry payload content. They are never valid on evidence or artifact records and
 * are rejected by the strict parsers even if they would otherwise fit the size cap.
 */
export const FORBIDDEN_CONTENT_KEYS: readonly string[] = Object.freeze([
  "prompt",
  "text",
  "input",
  "output",
  "report",
  "message",
  "payload",
  "body",
  "args",
  "content",
  "response",
  "completion",
])

// ── Artifact references ─────────────────────────────────────────────────────────────────────────

/** A content-free pointer to a payload the caller chose to retain out of band. */
export interface ArtifactRef {
  /** Caller-namespaced id. Opaque to nifra. */
  readonly id: string
  /** SHA-256 hex of the payload, for integrity and correlation. Content-free. */
  readonly digest: string
  readonly bytes: number
  readonly mediaType: string
  /** Optional caller-opaque locator (e.g. a private URI). nifra never dereferences it. */
  readonly locator?: string
}

/** What a payload is and where it came from, handed to the port at `put` time. */
export interface ArtifactContext {
  readonly planDigest: string
  readonly nodeId: string
  /** e.g. "prompt" | "model_output" | "tool_input" | "tool_output". */
  readonly kind: string
}

/**
 * Caller-owned sink for raw payloads - the ONLY place payload bytes leave transient execution.
 * The public repo ships only a discarding no-op and a disposable in-memory test port. No public
 * implementation persists.
 */
export interface ArtifactPort {
  put(payload: Uint8Array, ctx: ArtifactContext): ArtifactRef | Promise<ArtifactRef>
}

// ── Effect key ──────────────────────────────────────────────────────────────────────────────────

/** The stable, content-free identity of one side-effecting node attempt-boundary. */
export interface NodeEffectKey {
  /** SHA-256 hex over the canonical effect material. 64 lowercase hex chars. */
  readonly digest: string
  /** Non-secret structural coordinates, safe to log. */
  readonly planDigest: string
  readonly nodeId: string
}

// ── Run plan ────────────────────────────────────────────────────────────────────────────────────

/** Declarative node kinds. Each maps to an existing workflow primitive at compile time. */
export type RunNodeKind = "task" | "verify" | "approve" | "checkpoint" | "handoff"

/** A serializable plan node. `step` names a handler resolved locally through a StepCatalog. */
export interface RunNode {
  readonly id: string
  readonly kind: RunNodeKind
  /** StepCatalog key. The handler is registered locally and never persisted in the plan. */
  readonly step: string
  readonly dependsOn?: readonly string[]
  /** Required for `approve`; ignored otherwise. */
  readonly reason?: string
}

/** A serializable, closure-free run plan. */
export interface RunPlan {
  readonly version: typeof RUN_PLAN_VERSION
  readonly id: string
  readonly nodes: readonly RunNode[]
}

// ── Run evidence ────────────────────────────────────────────────────────────────────────────────

export type RunEvidenceStatus = "started" | "completed" | "failed"

/** The content-free projection of one run transition. Every field is id/hash/counter/status/timing. */
export interface RunEvidence {
  readonly version: typeof RUN_PLAN_VERSION
  readonly runId: string
  readonly planDigest: string
  readonly nodeId: string
  readonly status: RunEvidenceStatus
  readonly seq: number
  /** NodeEffectKey.digest when the node declared an effect selector; absent otherwise. */
  readonly effectKey?: string
  /** Whether the step declared an idempotency selector. */
  readonly idempotent: boolean
  readonly artifacts?: readonly ArtifactRef[]
  readonly errorCode?: string
  readonly durationMs?: number
}

// ── Strict parsers ──────────────────────────────────────────────────────────────────────────────

/** Thrown by every parser in this module on malformed or content-bearing input. Fails closed. */
export class RunContractError extends Error {
  constructor(readonly reason: string) {
    super(`orchestration contract: ${reason}`)
    this.name = "RunContractError"
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function assertNoForbiddenKeys(record: Record<string, unknown>, where: string): void {
  for (const key of FORBIDDEN_CONTENT_KEYS) {
    if (key in record) throw new RunContractError(`${where} carries forbidden content key '${key}'`)
  }
}

function assertOnlyKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new RunContractError(`${where} has unknown key '${key}'`)
  }
}

const HEX64 = /^[0-9a-f]{64}$/

function str(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key]
  if (typeof value !== "string" || value.length === 0)
    throw new RunContractError(`${where}.${key} must be a non-empty string`)
  return value
}

function int(record: Record<string, unknown>, key: string, where: string): number {
  const value = record[key]
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new RunContractError(`${where}.${key} must be a non-negative integer`)
  return value
}

/** Parse a content-free artifact reference. Rejects any non-schema or content key. */
export function parseArtifactRef(value: unknown): ArtifactRef {
  if (!isRecord(value)) throw new RunContractError("artifact ref must be an object")
  assertOnlyKeys(value, ["id", "digest", "bytes", "mediaType", "locator"], "artifact ref")
  assertNoForbiddenKeys(value, "artifact ref")
  const digest = str(value, "digest", "artifact ref")
  if (!HEX64.test(digest)) throw new RunContractError("artifact ref.digest must be sha256 hex")
  const ref: ArtifactRef = {
    id: str(value, "id", "artifact ref"),
    digest,
    bytes: int(value, "bytes", "artifact ref"),
    mediaType: str(value, "mediaType", "artifact ref"),
  }
  if (value.locator !== undefined) {
    if (typeof value.locator !== "string")
      throw new RunContractError("artifact ref.locator must be a string")
    return { ...ref, locator: value.locator }
  }
  return ref
}

const RUN_NODE_KINDS: readonly RunNodeKind[] = [
  "task",
  "verify",
  "approve",
  "checkpoint",
  "handoff",
]

/** Parse a declarative run plan. Rejects closures, unknown keys, and structural errors. */
export function parseRunPlan(value: unknown): RunPlan {
  if (!isRecord(value)) throw new RunContractError("run plan must be an object")
  assertOnlyKeys(value, ["version", "id", "nodes"], "run plan")
  if (value.version !== RUN_PLAN_VERSION)
    throw new RunContractError(`run plan.version must be ${RUN_PLAN_VERSION}`)
  if (!Array.isArray(value.nodes) || value.nodes.length === 0)
    throw new RunContractError("run plan.nodes must be a non-empty array")
  const nodes = value.nodes.map((raw, index): RunNode => {
    if (!isRecord(raw)) throw new RunContractError(`run plan.nodes[${index}] must be an object`)
    assertOnlyKeys(raw, ["id", "kind", "step", "dependsOn", "reason"], `node[${index}]`)
    assertNoForbiddenKeys(raw, `node[${index}]`)
    const kind = raw.kind
    if (typeof kind !== "string" || !RUN_NODE_KINDS.includes(kind as RunNodeKind))
      throw new RunContractError(`node[${index}].kind is invalid`)
    const node: RunNode = {
      id: str(raw, "id", `node[${index}]`),
      kind: kind as RunNodeKind,
      step: str(raw, "step", `node[${index}]`),
    }
    let out = node
    if (raw.dependsOn !== undefined) {
      if (!Array.isArray(raw.dependsOn) || raw.dependsOn.some((d) => typeof d !== "string"))
        throw new RunContractError(`node[${index}].dependsOn must be a string array`)
      out = { ...out, dependsOn: [...(raw.dependsOn as readonly string[])] }
    }
    if (raw.reason !== undefined) {
      if (typeof raw.reason !== "string")
        throw new RunContractError(`node[${index}].reason must be a string`)
      out = { ...out, reason: raw.reason }
    }
    if (out.kind === "approve" && out.reason === undefined)
      throw new RunContractError(`node[${index}] of kind 'approve' requires a reason`)
    return out
  })
  const ids = new Set<string>()
  for (const node of nodes) {
    if (ids.has(node.id)) throw new RunContractError(`duplicate node id '${node.id}'`)
    ids.add(node.id)
  }
  for (const node of nodes) {
    for (const dep of node.dependsOn ?? []) {
      if (!ids.has(dep)) throw new RunContractError(`node '${node.id}' depends on unknown '${dep}'`)
      if (dep === node.id) throw new RunContractError(`node '${node.id}' depends on itself`)
    }
  }
  return { version: RUN_PLAN_VERSION, id: str(value, "id", "run plan"), nodes }
}

/** Parse a content-free evidence record. Rejects content keys and any record over the size cap. */
export function parseRunEvidence(value: unknown): RunEvidence {
  if (!isRecord(value)) throw new RunContractError("evidence must be an object")
  assertOnlyKeys(
    value,
    [
      "version",
      "runId",
      "planDigest",
      "nodeId",
      "status",
      "seq",
      "effectKey",
      "idempotent",
      "artifacts",
      "errorCode",
      "durationMs",
    ],
    "evidence",
  )
  assertNoForbiddenKeys(value, "evidence")
  if (value.version !== RUN_PLAN_VERSION)
    throw new RunContractError(`evidence.version must be ${RUN_PLAN_VERSION}`)
  const status = value.status
  if (status !== "started" && status !== "completed" && status !== "failed")
    throw new RunContractError("evidence.status is invalid")
  if (typeof value.idempotent !== "boolean")
    throw new RunContractError("evidence.idempotent must be a boolean")
  const evidence: RunEvidence = {
    version: RUN_PLAN_VERSION,
    runId: str(value, "runId", "evidence"),
    planDigest: str(value, "planDigest", "evidence"),
    nodeId: str(value, "nodeId", "evidence"),
    status,
    seq: int(value, "seq", "evidence"),
    idempotent: value.idempotent,
    ...(value.effectKey !== undefined
      ? { effectKey: parseDigest(value.effectKey, "effectKey") }
      : {}),
    ...(value.errorCode !== undefined ? { errorCode: str(value, "errorCode", "evidence") } : {}),
    ...(value.durationMs !== undefined ? { durationMs: int(value, "durationMs", "evidence") } : {}),
    ...(value.artifacts !== undefined ? { artifacts: parseArtifacts(value.artifacts) } : {}),
  }
  assertEvidenceSize(evidence)
  return evidence
}

function parseDigest(value: unknown, field: string): string {
  if (typeof value !== "string" || !HEX64.test(value))
    throw new RunContractError(`evidence.${field} must be sha256 hex`)
  return value
}

function parseArtifacts(value: unknown): readonly ArtifactRef[] {
  if (!Array.isArray(value)) throw new RunContractError("evidence.artifacts must be an array")
  return value.map(parseArtifactRef)
}

/** Assert a record serializes within the hard cap. Public reference records are content-free. */
export function assertEvidenceSize(evidence: RunEvidence): void {
  const bytes = new TextEncoder().encode(JSON.stringify(evidence)).length
  if (bytes > EVIDENCE_MAX_BYTES)
    throw new RunContractError(`evidence record ${bytes}B exceeds ${EVIDENCE_MAX_BYTES}B cap`)
}
