/**
 * Certification profile for capability-descriptor adapters.
 *
 * An adapter that projects a tool, MCP tool, extension, model, or deployment target into a
 * {@link CapabilityDescriptor} is certified structurally: its output must parse cleanly, carry a real
 * schema digest, be free of any content-bearing field, compose into a deterministic snapshot, and
 * surface a schema change on a stable identity as drift rather than a silent overwrite. The profile
 * is dependency-free test evidence - an adapter package uses it only in CI, and the resulting matrix
 * is portable JSON that names capabilities, never payloads.
 */

import {
  AgentDeployment,
  type AgentDeploymentAdapter,
  createDeploymentAuthority,
  type ModelGateway,
  parseDeploymentCapabilityReport,
  parseModelGatewayError,
  parseModelGatewayResult,
  runModelGateway,
  structuredOutputParser,
} from "@nifrajs/agent"
import {
  type CapabilityDescriptor,
  composeRegistrySnapshot,
  parseCapabilityDescriptor,
  RegistryError,
} from "@nifrajs/agent/registry"
import { type AdapterCertificationProfile, defineCertificationProfile } from "./certification.ts"

/**
 * The test-only surface a descriptor adapter exposes for certification. `describe` yields the
 * adapter's representative descriptor; `describeDrift` yields a descriptor with the SAME identity
 * (kind and name) but a DIFFERENT schema digest, so the drift check can prove the adapter's identity
 * is stable across a schema change instead of colliding into it.
 */
export interface CertifiableDescriptorAdapter {
  describe(): CapabilityDescriptor | Promise<CapabilityDescriptor>
  describeDrift(): CapabilityDescriptor | Promise<CapabilityDescriptor>
}

const ALLOWED_KEYS: ReadonlySet<string> = new Set([
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

const SCHEMA_DIGEST = /^[0-9a-f]{64}$/

/**
 * Build the descriptor-adapter certification profile. Every check runs against a fresh adapter, so a
 * failure never leaks into the next capability's evidence.
 */
export function registryCertificationProfile(): AdapterCertificationProfile<CertifiableDescriptorAdapter> {
  return defineCertificationProfile<CertifiableDescriptorAdapter>({
    id: "capability-descriptor",
    version: 1,
    capabilities: ["content-free", "schema-digest", "snapshot-determinism", "drift-detection"],
    checks: [
      {
        id: "content-free",
        capability: "content-free",
        async run(adapter) {
          const descriptor = await adapter.describe()
          const parsed = parseCapabilityDescriptor(descriptor)
          for (const key of Object.keys(parsed)) {
            if (!ALLOWED_KEYS.has(key)) throw new Error("DescriptorExtraField")
          }
          if (parsed.descriptorVersion !== 1) throw new Error("DescriptorVersion")
        },
      },
      {
        id: "schema-digest",
        capability: "schema-digest",
        async run(adapter) {
          const descriptor = await adapter.describe()
          if (!SCHEMA_DIGEST.test(descriptor.schemaDigest))
            throw new Error("DescriptorSchemaDigest")
          if (descriptor.version.length === 0) throw new Error("DescriptorVersionMissing")
        },
      },
      {
        id: "snapshot-determinism",
        capability: "snapshot-determinism",
        async run(adapter) {
          const descriptor = await adapter.describe()
          const first = await composeRegistrySnapshot([descriptor])
          const second = await composeRegistrySnapshot([descriptor])
          if (first.digest !== second.digest) throw new Error("SnapshotNonDeterministic")
          if (first.descriptors.length !== 1) throw new Error("SnapshotDescriptorCount")
        },
      },
      {
        id: "identity-drift",
        capability: "drift-detection",
        async run(adapter) {
          const descriptor = await adapter.describe()
          const drift = await adapter.describeDrift()
          if (descriptor.kind !== drift.kind || descriptor.name !== drift.name)
            throw new Error("DriftIdentityMismatch")
          if (descriptor.schemaDigest === drift.schemaDigest)
            throw new Error("DriftDigestUnchanged")
          let code: string | undefined
          try {
            await composeRegistrySnapshot([descriptor, drift])
          } catch (error) {
            if (error instanceof RegistryError) code = error.code
          }
          if (code !== "schema_drift") throw new Error("DriftNotDetected")
        },
      },
    ],
  })
}

class NamedCertificationFailure extends Error {
  constructor(name: string) {
    super(name)
    this.name = name
  }
}

export interface CertifiableModelGateway extends ModelGateway {}

/** Certification for provider-neutral gateways. It never emits request or response content. */
export function gatewayCertificationProfile(): AdapterCertificationProfile<CertifiableModelGateway> {
  return defineCertificationProfile<CertifiableModelGateway>({
    id: "model-gateway",
    version: 1,
    capabilities: ["parse-boundary", "error-taxonomy", "fallback-policy", "evidence-firewall"],
    checks: [
      {
        id: "parse-boundary",
        capability: "parse-boundary",
        async run(adapter) {
          const result = await runModelGateway(
            adapter,
            { input: { probe: true }, parser: structuredOutputParser((value) => value) },
            { routes: ["cert-route"], retryableCodes: [], budget: { maxAttempts: 1 } },
          )
          if (!result.ok || result.evidence.some((item) => Object.hasOwn(item, "input")))
            throw new NamedCertificationFailure("GatewayParseBoundary")
        },
      },
      {
        id: "error-taxonomy",
        capability: "error-taxonomy",
        run() {
          for (const code of [
            "malformed_output",
            "refusal",
            "timeout",
            "rate_limit",
            "unavailable",
            "policy_denied",
            "cancelled",
            "internal",
          ] as const) {
            if (parseModelGatewayError({ code }).code !== code)
              throw new NamedCertificationFailure("GatewayErrorTaxonomy")
          }
        },
      },
      {
        id: "fallback-policy",
        capability: "fallback-policy",
        async run(adapter) {
          const result = await runModelGateway(
            adapter,
            { input: { probe: true } },
            {
              routes: ["cert-route", "cert-fallback"],
              retryableCodes: ["rate_limit", "unavailable"],
              allowFallback: true,
              budget: { maxAttempts: 2 },
            },
          )
          if (result.evidence.some((item) => item.kind === "fallback")) return
          if (!result.ok) throw new NamedCertificationFailure("GatewayFallback")
        },
      },
      {
        id: "evidence-firewall",
        capability: "evidence-firewall",
        async run(adapter) {
          const raw = await adapter.complete({
            routeId: "cert-route",
            input: { probe: true },
            signal: new AbortController().signal,
            envelope: { attempt: 1, attemptsRemaining: 0 },
          })
          if (parseModelGatewayResult(raw).ok === false && isRecordWithKey(raw, "evidence"))
            throw new NamedCertificationFailure("GatewayEvidenceFirewall")
          const result = await runModelGateway(
            adapter,
            { input: { prompt: "transient" } },
            { routes: ["cert-route"], retryableCodes: [], budget: { maxAttempts: 1 } },
          )
          const evidence = JSON.stringify(result.evidence).toLowerCase()
          if (/prompt|message|response|credential|secret|diagnostic|stack|content/.test(evidence))
            throw new NamedCertificationFailure("GatewayEvidenceFirewall")
        },
      },
    ],
  })
}

function isRecordWithKey(value: unknown, key: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.hasOwn(value, key)
  )
}

export const modelGatewayCertificationProfile = gatewayCertificationProfile

export interface CertifiableDeploymentAdapter extends AgentDeploymentAdapter {
  /** Required only when the adapter claims real OS hostile-code isolation. */
  readonly verifyHostileCodeIsolation?: () => boolean | PromiseLike<boolean>
}

/** Certification for lifecycle cleanup, capability truthfulness, authority, and isolation claims. */
export function deploymentCertificationProfile(): AdapterCertificationProfile<CertifiableDeploymentAdapter> {
  return defineCertificationProfile<CertifiableDeploymentAdapter>({
    id: "deployment-adapter",
    version: 1,
    capabilities: ["capability-truthfulness", "lifecycle", "cleanup", "isolation-claims"],
    checks: [
      {
        id: "capability-truthfulness",
        capability: "capability-truthfulness",
        async run(adapter) {
          const report = parseDeploymentCapabilityReport(await adapter.capabilityReport())
          if (report.adapterId !== adapter.id)
            throw new NamedCertificationFailure("DeploymentCapability")
        },
      },
      {
        id: "lifecycle",
        capability: "lifecycle",
        async run(adapter) {
          const deployment = new AgentDeployment(
            adapter,
            createDeploymentAuthority({ workspaceMaxBytes: 1024 * 1024 }),
          )
          await deployment.prepare({ deploymentId: "cert-deployment" })
          await deployment.start()
          const inspection = await deployment.inspect()
          if (inspection.state !== "running")
            throw new NamedCertificationFailure("DeploymentLifecycle")
          await deployment.cancel()
          await deployment.dispose()
        },
      },
      {
        id: "cleanup",
        capability: "cleanup",
        async run(adapter) {
          const deployment = new AgentDeployment(
            adapter,
            createDeploymentAuthority({ workspaceMaxBytes: 1024 * 1024 }),
          )
          await deployment.prepare({ deploymentId: "cert-cleanup" })
          await deployment.dispose()
          if (deployment.lifecycleState !== "disposed")
            throw new NamedCertificationFailure("DeploymentCleanup")
        },
      },
      {
        id: "isolation-claims",
        capability: "isolation-claims",
        async run(adapter) {
          const report = parseDeploymentCapabilityReport(await adapter.capabilityReport())
          if (report.capabilities.hostileCodeIsolation === "os") {
            if (
              adapter.verifyHostileCodeIsolation === undefined ||
              !(await adapter.verifyHostileCodeIsolation())
            )
              throw new NamedCertificationFailure("DeploymentIsolationClaim")
          }
        },
      },
    ],
  })
}

export const deploymentAdapterCertificationProfile = deploymentCertificationProfile
