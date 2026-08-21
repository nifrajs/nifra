/**
 * Content-free idempotency identity for one side-effecting node attempt-boundary.
 *
 * The step author projects only the identity-bearing subset of its input into a byte `selector`
 * (via `CatalogStep.selectEffect`). {@link deriveNodeEffectKey} frames that selector with the
 * non-secret plan/node coordinates and hashes the whole to a digest. The digest is what crosses a
 * boundary or lands in evidence; the selector bytes never leave this function. This mirrors
 * `@nifrajs/core`'s `computeIdempotencyFingerprint`: the hash is the key, the material is consumed.
 */

import type { NodeEffectKey } from "@nifrajs/agent-protocol"
import { sha256Hex } from "./hash.ts"

const encoder = new TextEncoder()

/** Inputs to the effect-key derivation. `selector` is the step's content-free identity projection. */
export interface EffectKeyMaterial {
  readonly planDigest: string
  readonly nodeId: string
  /** Identity-bearing bytes chosen by the step. Consumed into the hash, never retained. */
  readonly selector: Uint8Array
}

/**
 * Derive the stable, content-free key for a node attempt. The returned digest is safe to log and to
 * cross a boundary; two attempts with the same identity converge, distinct identities diverge.
 */
export async function deriveNodeEffectKey(material: EffectKeyMaterial): Promise<NodeEffectKey> {
  const header = encoder.encode(`${material.planDigest}\n${material.nodeId}\n`)
  const framed = new Uint8Array(header.length + material.selector.length)
  framed.set(header, 0)
  framed.set(material.selector, header.length)
  const digest = await sha256Hex(framed)
  return { digest, planDigest: material.planDigest, nodeId: material.nodeId }
}
