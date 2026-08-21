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

/** Leaf kinds resolve a StepCatalog handler; structural kinds compose child nodes. */
export type RunLeafKind = "task" | "verify" | "approve" | "checkpoint" | "handoff" | "subagent"
export type RunStructuralKind = "sequence" | "parallel" | "retry" | "branch"

/** Declarative node kinds. Each maps to an existing workflow primitive at compile time. */
export type RunNodeKind = RunLeafKind | RunStructuralKind

/** Bounded retry policy for a leaf node. Attempts map to the kernel's retry step. */
export interface RunRetryPolicy {
  readonly attempts: number
  readonly backoffMs?: number
}

/** A leaf plan node. `step` names a handler resolved locally through a StepCatalog. */
export interface RunLeafNode {
  readonly id: string
  readonly kind: RunLeafKind
  /** StepCatalog key. The handler is registered locally and never persisted in the plan. */
  readonly step: string
  /** Only meaningful on top-level nodes; nested children may not declare it. */
  readonly dependsOn?: readonly string[]
  /** Required for `approve`; ignored otherwise. */
  readonly reason?: string
  /** When set, the compiler asserts the resolved catalog step declares this exact version. */
  readonly stepVersion?: number
  /** Wraps this leaf's compiled step in a bounded retry. */
  readonly retry?: RunRetryPolicy
}

/** An ordered composite. Children run in declaration order. */
export interface RunSequenceNode {
  readonly id: string
  readonly kind: "sequence"
  readonly children: readonly RunNode[]
  readonly dependsOn?: readonly string[]
}

/** A bounded fan-out. Effective concurrency is the lower of this, the host, and the child count. */
export interface RunParallelNode {
  readonly id: string
  readonly kind: "parallel"
  readonly children: readonly RunNode[]
  readonly maxConcurrency?: number
  readonly dependsOn?: readonly string[]
}

/** A bounded retry wrapping a single child node. */
export interface RunRetryNode {
  readonly id: string
  readonly kind: "retry"
  readonly child: RunNode
  readonly attempts: number
  readonly backoffMs?: number
  readonly dependsOn?: readonly string[]
}

/** A conditional. `step` names a predicate catalog handler selecting `then` or `otherwise`. */
export interface RunBranchNode {
  readonly id: string
  readonly kind: "branch"
  readonly step: string
  readonly then: RunNode
  readonly otherwise?: RunNode
  readonly dependsOn?: readonly string[]
}

/** A serializable, closure-free plan node. Structural kinds nest into a tree. */
export type RunNode = RunLeafNode | RunSequenceNode | RunParallelNode | RunRetryNode | RunBranchNode

/** A serializable, closure-free run plan. Top-level nodes form a DAG; each node may nest a tree. */
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

const LEAF_KINDS: readonly RunLeafKind[] = [
  "task",
  "verify",
  "approve",
  "checkpoint",
  "handoff",
  "subagent",
]
const STRUCTURAL_KINDS: readonly RunStructuralKind[] = ["sequence", "parallel", "retry", "branch"]

function posInt(record: Record<string, unknown>, key: string, where: string): number {
  const value = record[key]
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new RunContractError(`${where}.${key} must be a positive integer`)
  return value
}

function parseDependsOn(
  raw: Record<string, unknown>,
  where: string,
  allowDepends: boolean,
): readonly string[] | undefined {
  if (raw.dependsOn === undefined) return undefined
  if (!allowDepends) throw new RunContractError(`${where} is nested and may not declare dependsOn`)
  if (!Array.isArray(raw.dependsOn) || raw.dependsOn.some((d) => typeof d !== "string"))
    throw new RunContractError(`${where}.dependsOn must be a string array`)
  return [...(raw.dependsOn as readonly string[])]
}

function parseRetryPolicy(value: unknown, where: string): RunRetryPolicy {
  if (!isRecord(value)) throw new RunContractError(`${where}.retry must be an object`)
  assertOnlyKeys(value, ["attempts", "backoffMs"], `${where}.retry`)
  const attempts = posInt(value, "attempts", `${where}.retry`)
  if (attempts > 16) throw new RunContractError(`${where}.retry.attempts must be 1..16`)
  if (value.backoffMs === undefined) return { attempts }
  return { attempts, backoffMs: int(value, "backoffMs", `${where}.retry`) }
}

/** Parse one node (recursively). `allowDepends` is true only for top-level nodes. */
function parseNode(raw: unknown, where: string, allowDepends: boolean, ids: Set<string>): RunNode {
  if (!isRecord(raw)) throw new RunContractError(`${where} must be an object`)
  const kind = raw.kind
  if (typeof kind !== "string") throw new RunContractError(`${where}.kind must be a string`)
  const isLeaf = LEAF_KINDS.includes(kind as RunLeafKind)
  if (!isLeaf && !STRUCTURAL_KINDS.includes(kind as RunStructuralKind))
    throw new RunContractError(`${where}.kind '${kind}' is invalid`)

  const allowed =
    kind === "sequence"
      ? ["id", "kind", "children", "dependsOn"]
      : kind === "parallel"
        ? ["id", "kind", "children", "maxConcurrency", "dependsOn"]
        : kind === "retry"
          ? ["id", "kind", "child", "attempts", "backoffMs", "dependsOn"]
          : kind === "branch"
            ? ["id", "kind", "step", "then", "otherwise", "dependsOn"]
            : ["id", "kind", "step", "dependsOn", "reason", "stepVersion", "retry"]
  assertOnlyKeys(raw, allowed, where)
  assertNoForbiddenKeys(raw, where)

  const id = str(raw, "id", where)
  if (ids.has(id)) throw new RunContractError(`duplicate node id '${id}'`)
  ids.add(id)
  const dependsOn = parseDependsOn(raw, where, allowDepends)
  const withDeps = <T extends { readonly kind: RunNodeKind }>(node: T): T =>
    dependsOn === undefined ? node : { ...node, dependsOn }

  if (isLeaf) {
    const leaf: RunLeafNode = { id, kind: kind as RunLeafKind, step: str(raw, "step", where) }
    let out = leaf
    if (raw.reason !== undefined) {
      if (typeof raw.reason !== "string")
        throw new RunContractError(`${where}.reason must be a string`)
      out = { ...out, reason: raw.reason }
    }
    if (kind === "approve" && out.reason === undefined)
      throw new RunContractError(`${where} of kind 'approve' requires a reason`)
    if (raw.stepVersion !== undefined)
      out = { ...out, stepVersion: posInt(raw, "stepVersion", where) }
    if (raw.retry !== undefined) out = { ...out, retry: parseRetryPolicy(raw.retry, where) }
    return withDeps(out)
  }

  if (kind === "sequence" || kind === "parallel") {
    if (!Array.isArray(raw.children) || raw.children.length === 0)
      throw new RunContractError(`${where}.children must be a non-empty array`)
    const children = raw.children.map((child, i) =>
      parseNode(child, `${where}.children[${i}]`, false, ids),
    )
    if (kind === "sequence") return withDeps({ id, kind, children })
    const node: RunParallelNode = { id, kind, children }
    return withDeps(
      raw.maxConcurrency === undefined
        ? node
        : { ...node, maxConcurrency: posInt(raw, "maxConcurrency", where) },
    )
  }

  if (kind === "retry") {
    const attempts = posInt(raw, "attempts", where)
    if (attempts > 16) throw new RunContractError(`${where}.attempts must be 1..16`)
    const child = parseNode(raw.child, `${where}.child`, false, ids)
    const node: RunRetryNode = { id, kind, child, attempts }
    return withDeps(
      raw.backoffMs === undefined ? node : { ...node, backoffMs: int(raw, "backoffMs", where) },
    )
  }

  // branch
  const then = parseNode(raw.then, `${where}.then`, false, ids)
  const node: RunBranchNode = { id, kind: "branch", step: str(raw, "step", where), then }
  return withDeps(
    raw.otherwise === undefined
      ? node
      : { ...node, otherwise: parseNode(raw.otherwise, `${where}.otherwise`, false, ids) },
  )
}

/** Parse a declarative run plan. Rejects closures, unknown keys, and structural errors. */
export function parseRunPlan(value: unknown): RunPlan {
  if (!isRecord(value)) throw new RunContractError("run plan must be an object")
  assertOnlyKeys(value, ["version", "id", "nodes"], "run plan")
  if (value.version !== RUN_PLAN_VERSION)
    throw new RunContractError(`run plan.version must be ${RUN_PLAN_VERSION}`)
  if (!Array.isArray(value.nodes) || value.nodes.length === 0)
    throw new RunContractError("run plan.nodes must be a non-empty array")
  const ids = new Set<string>()
  const nodes = value.nodes.map((raw, index) => parseNode(raw, `node[${index}]`, true, ids))
  const topLevel = new Set(nodes.map((node) => node.id))
  for (const node of nodes) {
    for (const dep of node.dependsOn ?? []) {
      if (dep === node.id) throw new RunContractError(`node '${node.id}' depends on itself`)
      if (!topLevel.has(dep))
        throw new RunContractError(`node '${node.id}' depends on unknown '${dep}'`)
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
