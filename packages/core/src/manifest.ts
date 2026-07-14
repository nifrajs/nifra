/** Deterministic, signed route manifest: contract × assurance × capabilities × classification. */

import type { AssuranceReport } from "./assurance.ts"
import type { CapabilityAssuranceReport } from "./capabilities.ts"
import {
  type DataClassification,
  isDataClassification,
  type ResponseClassification,
} from "./classification.ts"
import {
  type DiffSeverity,
  diffRouteSnapshots,
  type RouteChange,
  type RouteSnapshotSchema,
  snapshotRoutes,
} from "./diff.ts"
import { reflectRoutes } from "./reflection.ts"

export interface NifraManifestAssurance {
  readonly rule?: string
  readonly evidence: readonly { readonly id: string; readonly source: string }[]
}

export interface NifraManifestCapabilities {
  readonly declared: readonly string[]
  readonly evidenced: readonly string[]
  readonly unproven: readonly string[]
  readonly covered: boolean
}

export interface NifraManifestRoute {
  readonly method: string
  readonly path: string
  readonly schema?: RouteSnapshotSchema
  readonly assurance?: NifraManifestAssurance
  readonly capabilities?: NifraManifestCapabilities
  readonly classification?: ResponseClassification
}

export interface NifraManifest {
  readonly manifestVersion: 1
  readonly routes: readonly NifraManifestRoute[]
  /** SHA-256 hex of the canonical manifest body (`manifestVersion` + `routes`). */
  readonly contentHash: string
}

export interface NifraManifestSigner {
  readonly algorithm: "Ed25519"
  readonly keyId: string
  sign(payload: Uint8Array): ArrayBuffer | Uint8Array | Promise<ArrayBuffer | Uint8Array>
}

export interface NifraManifestSignature {
  readonly nifraManifestSignature: 1
  readonly algorithm: "Ed25519"
  readonly keyId: string
  readonly contentHash: string
  /** Base64url Ed25519 signature over the canonical manifest body. */
  readonly signature: string
}

export interface BuildNifraManifestInput {
  readonly source: unknown
  readonly assurance?: AssuranceReport
  readonly capabilities?: CapabilityAssuranceReport
}

const encoder = new TextEncoder()

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 31 || code === 127) return true
  }
  return false
}

function canonicalValue(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value)
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("nifra manifest cannot encode non-finite numbers")
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalValue(item)).join(",")}]`
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key])}`)
      .join(",")}}`
  }
  throw new TypeError(`nifra manifest cannot encode ${typeof value}`)
}

function manifestBody(manifest: Pick<NifraManifest, "manifestVersion" | "routes">): {
  readonly manifestVersion: 1
  readonly routes: readonly NifraManifestRoute[]
} {
  return { manifestVersion: 1, routes: manifest.routes }
}

/** Canonical bytes are stable across runtime, object-key order, and route registration order. */
export function canonicalManifest(
  manifest: Pick<NifraManifest, "manifestVersion" | "routes">,
): string {
  return canonicalValue(manifestBody(manifest))
}

/** Byte-stable artifact serialization (including `contentHash`). */
export function serializeNifraManifest(manifest: NifraManifest): string {
  return canonicalValue(manifest)
}

/** Byte-stable serialization for the detached signature sidecar. */
export function serializeNifraManifestSignature(signature: NifraManifestSignature): string {
  return canonicalValue(signature)
}

/** Parse the detached sidecar before selecting its operator-controlled public key. */
export function parseNifraManifestSignature(
  content: string,
  source = "manifest signature",
): NifraManifestSignature {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error(`nifra manifest: ${source} is not valid JSON`)
  }
  const candidate = parsed as Partial<NifraManifestSignature> | null
  let signatureLength = -1
  if (typeof candidate?.signature === "string") {
    try {
      signatureLength = fromBase64Url(candidate.signature).byteLength
    } catch {
      signatureLength = -1
    }
  }
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    candidate.nifraManifestSignature !== 1 ||
    candidate.algorithm !== "Ed25519" ||
    typeof candidate.keyId !== "string" ||
    candidate.keyId.trim() !== candidate.keyId ||
    candidate.keyId.length === 0 ||
    candidate.keyId.length > 255 ||
    hasControlCharacter(candidate.keyId) ||
    typeof candidate.contentHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(candidate.contentHash) ||
    typeof candidate.signature !== "string" ||
    signatureLength !== 64
  ) {
    throw new Error(`nifra manifest: ${source} is not a valid Ed25519 manifest signature`)
  }
  return Object.freeze(candidate as NifraManifestSignature)
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

const routeKey = (method: string, path: string): string => `${method.toUpperCase()}\n${path}`
const sortedStrings = (values: Iterable<string>): readonly string[] =>
  Object.freeze([...new Set(values)].sort())

/** Build one fail-closed, deterministic manifest from already-evaluated assurance reports. */
export async function buildNifraManifest(input: BuildNifraManifestInput): Promise<NifraManifest> {
  if (input.assurance !== undefined && !input.assurance.ok) {
    throw new Error("nifra manifest: refusing to emit failing route assurance")
  }
  if (input.capabilities !== undefined && !input.capabilities.ok) {
    throw new Error("nifra manifest: refusing to emit failing capability assurance")
  }
  const reflected = new Map(
    reflectRoutes(input.source).map((route) => [routeKey(route.method, route.path), route]),
  )
  const assured = new Map(
    (input.assurance?.routes ?? []).map((route) => [routeKey(route.method, route.path), route]),
  )
  const capable = new Map(
    (input.capabilities?.routes ?? []).map((route) => [routeKey(route.method, route.path), route]),
  )
  const routes = snapshotRoutes(input.source)
    .map((route): NifraManifestRoute => {
      const key = routeKey(route.method, route.path)
      const reflection = reflected.get(key)
      const assurance = assured.get(key)
      const capabilities = capable.get(key)
      return {
        method: route.method.toUpperCase(),
        path: route.path,
        ...(route.schema !== undefined ? { schema: route.schema } : {}),
        ...(assurance !== undefined
          ? {
              assurance: {
                ...(assurance.rule !== undefined ? { rule: assurance.rule } : {}),
                evidence: Object.freeze(
                  [...assurance.evidence]
                    .map((item) => ({ id: item.id, source: item.source }))
                    .sort((a, b) => a.id.localeCompare(b.id) || a.source.localeCompare(b.source)),
                ),
              },
            }
          : {}),
        ...(capabilities !== undefined
          ? {
              capabilities: {
                declared: sortedStrings(capabilities.declared),
                evidenced: sortedStrings(capabilities.evidence.map((item) => item.id)),
                unproven: sortedStrings(capabilities.unproven),
                covered: capabilities.covered,
              },
            }
          : {}),
        ...(reflection?.classification !== undefined
          ? { classification: reflection.classification }
          : {}),
      }
    })
    .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
  const body = Object.freeze({ manifestVersion: 1 as const, routes: Object.freeze(routes) })
  return Object.freeze({ ...body, contentHash: await sha256Hex(canonicalManifest(body)) })
}

function base64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError("invalid base64url signature")
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=")
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** Sign without handling private keys: the operator-supplied signer may call KMS/HSM/local WebCrypto. */
export async function signNifraManifest(
  manifest: NifraManifest,
  signer: NifraManifestSigner,
): Promise<NifraManifestSignature> {
  const canonical = canonicalManifest(manifest)
  if ((await sha256Hex(canonical)) !== manifest.contentHash) {
    throw new Error("nifra manifest: contentHash does not match canonical content")
  }
  if (
    signer.algorithm !== "Ed25519" ||
    signer.keyId.trim() !== signer.keyId ||
    signer.keyId.length === 0 ||
    signer.keyId.length > 255 ||
    hasControlCharacter(signer.keyId)
  ) {
    throw new TypeError("nifra manifest: signer requires Ed25519 and a non-empty keyId")
  }
  const signed = await signer.sign(encoder.encode(canonical))
  if (signed.byteLength !== 64) {
    throw new TypeError("nifra manifest: Ed25519 signer must return a 64-byte signature")
  }
  return Object.freeze({
    nifraManifestSignature: 1,
    algorithm: "Ed25519",
    keyId: signer.keyId,
    contentHash: manifest.contentHash,
    signature: base64Url(new Uint8Array(signed)),
  })
}

/** Verify the hash first, then the detached Ed25519 signature. Malformed/tampered input returns false. */
export async function verifyNifraManifestSignature(
  manifest: NifraManifest,
  signature: NifraManifestSignature,
  publicKey: CryptoKey,
): Promise<boolean> {
  try {
    const canonical = canonicalManifest(manifest)
    const contentHash = await sha256Hex(canonical)
    if (
      contentHash !== manifest.contentHash ||
      signature.nifraManifestSignature !== 1 ||
      signature.algorithm !== "Ed25519" ||
      signature.contentHash !== contentHash
    ) {
      return false
    }
    return await crypto.subtle.verify(
      "Ed25519",
      publicKey,
      fromBase64Url(signature.signature),
      encoder.encode(canonical),
    )
  } catch {
    return false
  }
}

/** Parse and hash-verify an emitted manifest before it is trusted by diff/codegen tooling. */
export async function parseNifraManifest(
  content: string,
  source = "manifest",
): Promise<NifraManifest> {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error(`nifra manifest: ${source} is not valid JSON`)
  }
  const candidate = parsed as Partial<NifraManifest> | null
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    candidate.manifestVersion !== 1 ||
    !Array.isArray(candidate.routes) ||
    typeof candidate.contentHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(candidate.contentHash)
  ) {
    throw new Error(`nifra manifest: ${source} is not a version 1 Nifra manifest`)
  }
  const seen = new Set<string>()
  for (const route of candidate.routes) {
    if (
      route === null ||
      typeof route !== "object" ||
      typeof route.method !== "string" ||
      typeof route.path !== "string" ||
      !route.path.startsWith("/")
    ) {
      throw new Error(`nifra manifest: ${source} contains an invalid route`)
    }
    const typed = route as Partial<NifraManifestRoute>
    if (!/^[A-Z]+$/.test(typed.method as string)) {
      throw new Error(`nifra manifest: ${source} contains an invalid route method`)
    }
    const key = routeKey(typed.method as string, typed.path as string)
    if (seen.has(key)) throw new Error(`nifra manifest: ${source} contains a duplicate route`)
    seen.add(key)
    if (typed.assurance !== undefined) {
      if (
        typed.assurance === null ||
        typeof typed.assurance !== "object" ||
        !Array.isArray(typed.assurance.evidence) ||
        (typed.assurance.rule !== undefined && typeof typed.assurance.rule !== "string") ||
        typed.assurance.evidence.some(
          (item) =>
            item === null ||
            typeof item !== "object" ||
            typeof item.id !== "string" ||
            typeof item.source !== "string",
        )
      ) {
        throw new Error(`nifra manifest: ${source} contains invalid assurance material`)
      }
    }
    if (typed.capabilities !== undefined) {
      const capabilities = typed.capabilities
      if (
        capabilities === null ||
        typeof capabilities !== "object" ||
        !Array.isArray(capabilities.declared) ||
        !Array.isArray(capabilities.evidenced) ||
        !Array.isArray(capabilities.unproven) ||
        typeof capabilities.covered !== "boolean" ||
        [...capabilities.declared, ...capabilities.evidenced, ...capabilities.unproven].some(
          (value) => typeof value !== "string" || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(value),
        )
      ) {
        throw new Error(`nifra manifest: ${source} contains invalid capability material`)
      }
    }
    if (typed.classification !== undefined) {
      const classification = typed.classification
      if (
        classification === null ||
        typeof classification !== "object" ||
        !isDataClassification(classification.max) ||
        classification.fields === null ||
        typeof classification.fields !== "object" ||
        Array.isArray(classification.fields) ||
        Object.values(classification.fields).some((value) => !isDataClassification(value))
      ) {
        throw new Error(`nifra manifest: ${source} contains invalid response classification`)
      }
    }
  }
  const manifest = candidate as NifraManifest
  if ((await sha256Hex(canonicalManifest(manifest))) !== manifest.contentHash) {
    throw new Error(`nifra manifest: ${source} contentHash mismatch`)
  }
  return manifest
}

export interface NifraManifestChange {
  readonly severity: DiffSeverity
  readonly method: string
  readonly path: string
  readonly section: RouteChange["section"] | "assurance" | "capabilities" | "classification"
  readonly field?: string
  readonly message: string
}

export interface NifraManifestDiff {
  readonly changes: readonly NifraManifestChange[]
  readonly hasBreaking: boolean
}

function listChanges(
  before: readonly string[],
  after: readonly string[],
): {
  added: string[]
  removed: string[]
} {
  return {
    added: after.filter((value) => !before.includes(value)),
    removed: before.filter((value) => !after.includes(value)),
  }
}

const classificationRank = (value: DataClassification | undefined): number =>
  value === undefined ? -1 : value === "public" ? 0 : value === "pii" ? 1 : 2

/** Contract changes reuse the route-diff engine; governance changes fail closed on expanded risk. */
export function diffNifraManifests(before: NifraManifest, after: NifraManifest): NifraManifestDiff {
  const changes: NifraManifestChange[] = [
    ...diffRouteSnapshots(before.routes, after.routes).changes,
  ]
  const previous = new Map(
    before.routes.map((route) => [routeKey(route.method, route.path), route]),
  )
  for (const route of after.routes) {
    const old = previous.get(routeKey(route.method, route.path))
    if (old === undefined) continue
    const base = { method: route.method, path: route.path } as const

    const oldRule = old.assurance?.rule
    const newRule = route.assurance?.rule
    if (oldRule !== newRule) {
      changes.push({
        ...base,
        section: "assurance",
        severity: "breaking",
        message: `assurance rule changed from ${oldRule ?? "unclassified"} to ${newRule ?? "unclassified"}`,
      })
    }
    const oldEvidence = (old.assurance?.evidence ?? [])
      .map((item) => `${item.id}@${item.source}`)
      .sort()
    const newEvidence = (route.assurance?.evidence ?? [])
      .map((item) => `${item.id}@${item.source}`)
      .sort()
    const assuranceDelta = listChanges(oldEvidence, newEvidence)
    for (const value of assuranceDelta.added) {
      changes.push({
        ...base,
        section: "assurance",
        severity: "compatible",
        message: `assurance evidence added ${value}`,
      })
    }
    for (const value of assuranceDelta.removed) {
      changes.push({
        ...base,
        section: "assurance",
        severity: "breaking",
        message: `assurance evidence removed ${value}`,
      })
    }

    for (const field of ["declared", "evidenced", "unproven"] as const) {
      const delta = listChanges(old.capabilities?.[field] ?? [], route.capabilities?.[field] ?? [])
      for (const value of delta.added) {
        changes.push({
          ...base,
          section: "capabilities",
          field,
          severity: "breaking",
          message: `${field} capability added ${value}`,
        })
      }
      for (const value of delta.removed) {
        changes.push({
          ...base,
          section: "capabilities",
          field,
          severity: "compatible",
          message: `${field} capability removed ${value}`,
        })
      }
    }
    if (old.capabilities?.covered === true && route.capabilities?.covered !== true) {
      changes.push({
        ...base,
        section: "capabilities",
        severity: "breaking",
        message: "capability provenance coverage lost",
      })
    }

    const beforeClassification = old.classification?.max
    const afterClassification = route.classification?.max
    if (beforeClassification !== afterClassification) {
      const increased =
        classificationRank(afterClassification) > classificationRank(beforeClassification)
      changes.push({
        ...base,
        section: "classification",
        severity:
          increased && classificationRank(afterClassification) > 0 ? "breaking" : "compatible",
        message: `response classification changed from ${beforeClassification ?? "unclassified"} to ${afterClassification ?? "unclassified"}`,
      })
    }
    const oldFields = old.classification?.fields ?? {}
    const newFields = route.classification?.fields ?? {}
    for (const field of new Set([...Object.keys(oldFields), ...Object.keys(newFields)])) {
      const previousTag = oldFields[field]
      const currentTag = newFields[field]
      if (previousTag === currentTag) continue
      const increased = classificationRank(currentTag) > classificationRank(previousTag)
      changes.push({
        ...base,
        section: "classification",
        field,
        severity: increased && classificationRank(currentTag) > 0 ? "breaking" : "compatible",
        message: `response field classification changed from ${previousTag ?? "unclassified"} to ${currentTag ?? "unclassified"}`,
      })
    }
  }
  return Object.freeze({
    changes: Object.freeze(changes),
    hasBreaking: changes.some((change) => change.severity === "breaking"),
  })
}
