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
