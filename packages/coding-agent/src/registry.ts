/**
 * Capability-descriptor adapter for coding-agent extensions.
 *
 * An extension is host-supplied code that runs with granted capabilities, so its descriptor is
 * projected under the `extension` kind and, unlike a typed tool, admits an opaque input. The adapter
 * fails closed on capability escalation: an extension must declare its capabilities explicitly (an
 * empty array asserts "none"), and every declared capability must appear in the host's trusted
 * allowlist. An omitted declaration or any capability outside the allowlist raises
 * `capability_escalation` rather than silently narrowing or widening the grant.
 *
 * This module is the only place `@nifrajs/coding-agent` reaches `@nifrajs/agent`; the edge is
 * `coding-agent -> agent`, never the reverse, so the agent package stays free of coding-agent code.
 */

import {
  type ApprovalClass,
  type CapabilityDescriptor,
  composeDescriptor,
  type IsolationClass,
  RegistryError,
} from "@nifrajs/agent/registry"

/** Opaque extension input. Extensions do not publish a typed schema, so identity rests on name and grant. */
const EXTENSION_INPUT_SCHEMA: Record<string, unknown> = Object.freeze({
  type: "object",
  additionalProperties: true,
})

/** The minimal shape an extension exposes for projection: an identity and an explicit capability grant. */
export interface ExtensionDescriptorSource {
  readonly name: string
  readonly capabilities?: readonly string[]
}

export interface ExtensionDescriptorOptions {
  /** The host's trusted capability allowlist. A declared capability outside it fails closed. */
  readonly trustedCapabilities: readonly string[]
  readonly version?: string
  readonly approval?: ApprovalClass
  readonly isolation?: IsolationClass
}

/**
 * Project one extension into an `extension` capability descriptor, enforcing the grant. The declared
 * capabilities become the descriptor's required capabilities only after every one is confirmed
 * trusted; an undeclared grant or an escalated capability throws before any descriptor is built.
 * Approval defaults to required and isolation to process, matching how untyped host code is admitted.
 */
export function extensionDescriptor(
  extension: ExtensionDescriptorSource,
  options: ExtensionDescriptorOptions,
): Promise<CapabilityDescriptor> {
  const requested = extension.capabilities
  if (requested === undefined) throw new RegistryError("capability_escalation")
  const trusted = new Set(options.trustedCapabilities)
  for (const capability of requested) {
    if (!trusted.has(capability)) throw new RegistryError("capability_escalation")
  }
  return composeDescriptor({
    kind: "extension",
    name: extension.name,
    ...(options.version === undefined ? {} : { version: options.version }),
    inputSchema: EXTENSION_INPUT_SCHEMA,
    requiredCapabilities: requested,
    approval: options.approval ?? { kind: "required" },
    retry: "none",
    idempotency: "none",
    isolation: options.isolation ?? "process",
  })
}

/** Project a set of extensions under a single trusted allowlist, preserving order. */
export function extensionDescriptors(
  extensions: readonly ExtensionDescriptorSource[],
  options: ExtensionDescriptorOptions,
): Promise<readonly CapabilityDescriptor[]> {
  return Promise.all(extensions.map((extension) => extensionDescriptor(extension, options)))
}

export type { CapabilityDescriptor }
