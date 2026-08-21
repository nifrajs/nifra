/**
 * Unified capability descriptor registry.
 *
 * A {@link CapabilityDescriptor} is the content-free identity card of one invokable capability - a
 * core tool, an MCP tool, a coding-agent extension, a model adapter, or a deployment adapter. It
 * carries a stable name, a version, a kind, a schema digest, the capabilities it requires, and the
 * host-policy classes (approval, retry, idempotency, isolation) the host uses to admit it. It never
 * carries a description, an input or output payload, a prompt, or any other content: the digest is
 * taken over the input JSON schema, so two producers of the same capability agree on identity
 * without either exposing a request body.
 *
 * A {@link RegistrySnapshot} composes many descriptors into a deterministic, collision-checked set
 * with a single snapshot digest. Canonical ordering makes the digest independent of input order, so
 * reordering declarations can never change it. Every failure raises a {@link RegistryError} with a
 * stable {@link RegistryErrorCode}; nothing here throws a message that could carry content.
 *
 * The package depends only on `@nifrajs/core`. The MCP and coding-agent adapters live in their own
 * packages and consume these contracts through the declared `@nifrajs/agent` edge - never the
 * reverse - so neither this package nor the protocol ever imports MCP transport or the coding agent.
 */

import type { ToolContract } from "@nifrajs/core/tool-contract"
import { toolInputJsonSchema } from "@nifrajs/core/tool-contract"

export const CAPABILITY_DESCRIPTOR_VERSION = 1 as const
export const REGISTRY_SNAPSHOT_VERSION = 1 as const

/** Producer families a descriptor can describe. A value outside this set fails `unsupported_kind`. */
export type CapabilityKind =
  | "tool"
  | "mcp-tool"
  | "extension"
  | "model-adapter"
  | "deployment-adapter"

const CAPABILITY_KINDS: ReadonlySet<string> = new Set<CapabilityKind>([
  "tool",
  "mcp-tool",
  "extension",
  "model-adapter",
  "deployment-adapter",
])

/** Host approval requirement. Mirrors the core tool approval policy; a numeric level is not content. */
export type ApprovalClass =
  | { readonly kind: "none" }
  | { readonly kind: "required" }
  | { readonly kind: "threshold"; readonly level: number }

/** Whether a failed invocation may be retried. A capability is retry-eligible only when idempotent. */
export type RetryClass = "none" | "idempotent"
const RETRY_CLASSES: ReadonlySet<string> = new Set<RetryClass>(["none", "idempotent"])

/** Idempotency guarantee a capability declares, mirroring the tool idempotency scope. */
export type IdempotencyClass = "none" | "request" | "durable"
const IDEMPOTENCY_CLASSES: ReadonlySet<string> = new Set<IdempotencyClass>([
  "none",
  "request",
  "durable",
])

/** Isolation the host must provide to invoke the capability. */
export type IsolationClass = "inherit" | "process" | "sandbox"
const ISOLATION_CLASSES: ReadonlySet<string> = new Set<IsolationClass>([
  "inherit",
  "process",
  "sandbox",
])

export interface CapabilityDescriptor {
  readonly descriptorVersion: typeof CAPABILITY_DESCRIPTOR_VERSION
  readonly kind: CapabilityKind
  readonly name: string
  readonly version: string
  /** SHA-256 hex over the canonical input JSON schema. Identity without exposing a request body. */
  readonly schemaDigest: string
  readonly requiredCapabilities: readonly string[]
  readonly approval: ApprovalClass
  readonly retry: RetryClass
  readonly idempotency: IdempotencyClass
  readonly isolation: IsolationClass
}

export interface RegistrySnapshot {
  readonly version: typeof REGISTRY_SNAPSHOT_VERSION
  /** SHA-256 hex over the canonically ordered descriptor set. Independent of input order. */
  readonly digest: string
  readonly descriptors: readonly CapabilityDescriptor[]
}

export type RegistryErrorCode =
  | "invalid_descriptor"
  | "unsupported_kind"
  | "missing_version"
  | "invalid_name"
  | "invalid_capability"
  | "content_field"
  | "invalid_schema_digest"
  | "invalid_approval"
  | "descriptor_collision"
  | "schema_drift"
  | "capability_escalation"

/** A stable, content-free failure. `code` is the machine-addressable reason; the message is generic. */
export class RegistryError extends Error {
  readonly code: RegistryErrorCode

  constructor(code: RegistryErrorCode, message = code) {
    super(message)
    this.code = code
    this.name = "RegistryError"
  }
}

const NAME_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const CAPABILITY_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/
const VERSION_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,63}$/
const SCHEMA_DIGEST = /^[0-9a-f]{64}$/

const DESCRIPTOR_KEYS: ReadonlySet<string> = new Set([
  "descriptorVersion",
  "kind",
  "name",
  "version",
  "schemaDigest",
  "requiredCapabilities",
  "approval",
  "retry",
  "idempotency",
  "isolation",
])

/**
 * Keys that would carry content or a payload. Their mere presence on a descriptor object is a
 * boundary violation and fails `content_field`, distinct from an unknown structural field.
 */
const CONTENT_KEYS: ReadonlySet<string> = new Set([
  "description",
  "instruction",
  "input",
  "output",
  "inputSchema",
  "outputSchema",
  "content",
  "prompt",
  "text",
  "message",
  "arguments",
  "args",
  "params",
  "parameters",
  "result",
  "payload",
  "body",
  "data",
])

const encoder = new TextEncoder()

/** SHA-256 hex of a UTF-8 string. Collision-resistant, so a digest cannot be forged from content. */
async function sha256HexOf(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text))
  const view = new Uint8Array(digest)
  let hex = ""
  for (let i = 0; i < view.length; i++) hex += (view[i] as number).toString(16).padStart(2, "0")
  return hex
}

/** Deterministic JSON with recursively sorted object keys. Arrays keep order; non-finite rejected. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value)
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite JSON number")
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`
  }
  throw new TypeError(`cannot canonicalize ${typeof value}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseKind(value: unknown): CapabilityKind {
  if (typeof value !== "string" || !CAPABILITY_KINDS.has(value))
    throw new RegistryError("unsupported_kind")
  return value as CapabilityKind
}

function parseName(value: unknown): string {
  if (typeof value !== "string" || !NAME_TOKEN.test(value)) throw new RegistryError("invalid_name")
  return value
}

function parseVersion(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new RegistryError("missing_version")
  if (!VERSION_TOKEN.test(value)) throw new RegistryError("missing_version")
  return value
}

function parseRequiredCapabilities(value: unknown): readonly string[] {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value)) throw new RegistryError("invalid_capability")
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== "string" || !CAPABILITY_TOKEN.test(entry))
      throw new RegistryError("invalid_capability")
    seen.add(entry)
  }
  return Object.freeze([...seen].sort())
}

function parseApproval(value: unknown): ApprovalClass {
  if (value === undefined) return { kind: "none" }
  if (!isRecord(value)) throw new RegistryError("invalid_approval")
  if (value.kind === "none") return { kind: "none" }
  if (value.kind === "required") return { kind: "required" }
  if (value.kind === "threshold") {
    const level = value.level
    if (typeof level !== "number" || !Number.isInteger(level) || level < 0)
      throw new RegistryError("invalid_approval")
    return { kind: "threshold", level }
  }
  throw new RegistryError("invalid_approval")
}

function parseMember<T extends string>(
  value: unknown,
  members: ReadonlySet<string>,
  fallback: T,
  code: RegistryErrorCode,
): T {
  if (value === undefined) return fallback
  if (typeof value !== "string" || !members.has(value)) throw new RegistryError(code)
  return value as T
}

function assertNoContentFields(record: Record<string, unknown>): void {
  for (const key of Object.keys(record)) {
    if (DESCRIPTOR_KEYS.has(key)) continue
    if (CONTENT_KEYS.has(key)) throw new RegistryError("content_field")
    throw new RegistryError("invalid_descriptor")
  }
}

/**
 * Validate an untrusted value as a {@link CapabilityDescriptor}, normalizing capability order. Missing,
 * unknown, or content-bearing fields are rejected with a stable code. This is the single admission
 * point: every adapter output and every wire value passes through it before it enters a snapshot.
 */
export function parseCapabilityDescriptor(value: unknown): CapabilityDescriptor {
  if (!isRecord(value)) throw new RegistryError("invalid_descriptor")
  assertNoContentFields(value)
  if (value.descriptorVersion !== CAPABILITY_DESCRIPTOR_VERSION)
    throw new RegistryError("invalid_descriptor")
  const kind = parseKind(value.kind)
  const name = parseName(value.name)
  const version = parseVersion(value.version)
  if (typeof value.schemaDigest !== "string" || !SCHEMA_DIGEST.test(value.schemaDigest))
    throw new RegistryError("invalid_schema_digest")
  const requiredCapabilities = parseRequiredCapabilities(value.requiredCapabilities)
  const approval = parseApproval(value.approval)
  const retry = parseMember<RetryClass>(value.retry, RETRY_CLASSES, "none", "invalid_descriptor")
  const idempotency = parseMember<IdempotencyClass>(
    value.idempotency,
    IDEMPOTENCY_CLASSES,
    "none",
    "invalid_descriptor",
  )
  const isolation = parseMember<IsolationClass>(
    value.isolation,
    ISOLATION_CLASSES,
    "inherit",
    "invalid_descriptor",
  )
  return Object.freeze({
    descriptorVersion: CAPABILITY_DESCRIPTOR_VERSION,
    kind,
    name,
    version,
    schemaDigest: value.schemaDigest,
    requiredCapabilities,
    approval: Object.freeze(approval),
    retry,
    idempotency,
    isolation,
  })
}

/** The fields an adapter supplies. The schema digest is derived from `inputSchema`, never passed in. */
export interface DescriptorInput {
  readonly kind: CapabilityKind
  readonly name: string
  readonly version?: string
  /** The capability's input JSON schema. Digested for identity; the schema itself is not stored. */
  readonly inputSchema: Record<string, unknown>
  readonly requiredCapabilities?: readonly string[]
  readonly approval?: ApprovalClass
  readonly retry?: RetryClass
  readonly idempotency?: IdempotencyClass
  readonly isolation?: IsolationClass
}

const DEFAULT_DESCRIPTOR_VERSION = "1.0.0"

/**
 * Build a validated descriptor from adapter fields, digesting the input schema. Two adapters that
 * describe the same capability (same kind, name, version, schema, and classes) produce byte-identical
 * descriptors and therefore the same digest, which is what makes cross-package parity checkable.
 */
export async function composeDescriptor(input: DescriptorInput): Promise<CapabilityDescriptor> {
  const kind = parseKind(input.kind)
  const name = parseName(input.name)
  const version = parseVersion(input.version ?? DEFAULT_DESCRIPTOR_VERSION)
  if (!isRecord(input.inputSchema)) throw new RegistryError("invalid_descriptor")
  const schemaDigest = await sha256HexOf(canonicalJson(input.inputSchema))
  const requiredCapabilities = parseRequiredCapabilities(input.requiredCapabilities)
  const approval = parseApproval(input.approval)
  const retry = parseMember<RetryClass>(input.retry, RETRY_CLASSES, "none", "invalid_descriptor")
  const idempotency = parseMember<IdempotencyClass>(
    input.idempotency,
    IDEMPOTENCY_CLASSES,
    "none",
    "invalid_descriptor",
  )
  const isolation = parseMember<IsolationClass>(
    input.isolation,
    ISOLATION_CLASSES,
    "inherit",
    "invalid_descriptor",
  )
  return Object.freeze({
    descriptorVersion: CAPABILITY_DESCRIPTOR_VERSION,
    kind,
    name,
    version,
    schemaDigest,
    requiredCapabilities,
    approval: Object.freeze(approval),
    retry,
    idempotency,
    isolation,
  })
}

export interface ToolDescriptorOptions {
  /** Kind to record. Defaults to `tool`; the MCP adapter passes `mcp-tool` for the same contract. */
  readonly kind?: CapabilityKind
  readonly version?: string
  readonly isolation?: IsolationClass
}

/**
 * Adapt a Nifra core {@link ToolContract} into a descriptor without touching its execution contract.
 * The schema digest is taken over the tool's own input JSON schema, retry follows idempotency, and
 * the approval policy is carried through unchanged, so the descriptor is a faithful, content-free
 * projection of the contract the runtime already enforces.
 */
export function descriptorFromTool<Input, Output>(
  tool: ToolContract<Input, Output>,
  options: ToolDescriptorOptions = {},
): Promise<CapabilityDescriptor> {
  return composeDescriptor({
    kind: options.kind ?? "tool",
    name: tool.name,
    ...(options.version === undefined ? {} : { version: options.version }),
    inputSchema: toolInputJsonSchema(tool),
    requiredCapabilities: [tool.capability],
    approval: tool.approval,
    retry: tool.idempotency === undefined ? "none" : "idempotent",
    idempotency: tool.idempotency === undefined ? "none" : tool.idempotency.scope,
    isolation: options.isolation ?? "inherit",
  })
}

function identityKey(descriptor: CapabilityDescriptor): string {
  return `${descriptor.kind} ${descriptor.name}`
}

function compareDescriptors(a: CapabilityDescriptor, b: CapabilityDescriptor): number {
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1
  if (a.name !== b.name) return a.name < b.name ? -1 : 1
  if (a.version !== b.version) return a.version < b.version ? -1 : 1
  return 0
}

function canonicalDescriptor(descriptor: CapabilityDescriptor): Record<string, unknown> {
  return {
    descriptorVersion: descriptor.descriptorVersion,
    kind: descriptor.kind,
    name: descriptor.name,
    version: descriptor.version,
    schemaDigest: descriptor.schemaDigest,
    requiredCapabilities: [...descriptor.requiredCapabilities],
    approval: { ...descriptor.approval },
    retry: descriptor.retry,
    idempotency: descriptor.idempotency,
    isolation: descriptor.isolation,
  }
}

/**
 * Compose a deterministic registry snapshot. Descriptors are validated, checked for identity
 * collisions, canonically ordered, and digested. Two descriptors that share a (kind, name) identity
 * fail `descriptor_collision` when their schema digests agree and `schema_drift` when they differ -
 * a drifted schema is a distinct, addressable failure from a duplicate registration. Because the set
 * is sorted before it is digested, the snapshot digest is independent of the input order.
 */
export async function composeRegistrySnapshot(
  descriptors: readonly CapabilityDescriptor[],
): Promise<RegistrySnapshot> {
  const validated = descriptors.map((descriptor) => parseCapabilityDescriptor(descriptor))
  const byIdentity = new Map<string, CapabilityDescriptor>()
  for (const descriptor of validated) {
    const key = identityKey(descriptor)
    const existing = byIdentity.get(key)
    if (existing !== undefined) {
      throw new RegistryError(
        existing.schemaDigest === descriptor.schemaDigest ? "descriptor_collision" : "schema_drift",
      )
    }
    byIdentity.set(key, descriptor)
  }
  const ordered = [...validated].sort(compareDescriptors)
  const digest = await sha256HexOf(
    canonicalJson({
      version: REGISTRY_SNAPSHOT_VERSION,
      descriptors: ordered.map(canonicalDescriptor),
    }),
  )
  return Object.freeze({
    version: REGISTRY_SNAPSHOT_VERSION,
    digest,
    descriptors: Object.freeze(ordered),
  })
}
