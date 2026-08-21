/**
 * Reference {@link ArtifactPort} implementations - the only artifact sinks the public repo ships.
 *
 * Neither persists durably: {@link noopArtifactPort} hashes and discards; {@link memoryArtifactPort}
 * keeps bytes in a bounded process-local map for tests only and refuses a large budget. A durable,
 * tenant-aware, or encrypted store is caller-owned and never lives here - the absence of a
 * persisting sink in the public package IS the privacy guardrail.
 */

import type { ArtifactContext, ArtifactPort, ArtifactRef } from "@nifrajs/agent-protocol"
import { sha256Hex } from "./hash.ts"

function refId(digest: string, ctx: ArtifactContext): string {
  return `${ctx.nodeId}:${ctx.kind}:${digest.slice(0, 16)}`
}

/**
 * Hashes the payload for a content-free {@link ArtifactRef}, then discards the bytes. The default
 * port: public code sees only the digest, size, and coordinates - never the payload.
 */
export function noopArtifactPort(): ArtifactPort {
  return {
    async put(payload: Uint8Array, ctx: ArtifactContext): Promise<ArtifactRef> {
      const digest = await sha256Hex(payload)
      return {
        id: refId(digest, ctx),
        digest,
        bytes: payload.length,
        mediaType: "application/octet-stream",
      }
    },
  }
}

/** A memory port that additionally exposes stored bytes for assertions. Test-only. */
export interface MemoryArtifactPort extends ArtifactPort {
  /** Return the retained bytes for an id, or undefined. Test assertions only. */
  get(id: string): Uint8Array | undefined
  /** Number of retained payloads. */
  readonly count: number
}

/**
 * A disposable in-memory port for tests. Retains payloads up to a small byte budget and throws past
 * it, refusing any load that resembles durable use. NEVER use outside tests - it has no persistence,
 * no tenancy, and no eviction beyond the hard cap.
 */
export function memoryArtifactPort(
  options: { readonly maxBytes?: number } = {},
): MemoryArtifactPort {
  const maxBytes = options.maxBytes ?? 1_048_576
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new RangeError("memoryArtifactPort: maxBytes must be a positive integer")
  const store = new Map<string, Uint8Array>()
  let total = 0
  return {
    get count() {
      return store.size
    },
    get(id: string): Uint8Array | undefined {
      return store.get(id)
    },
    async put(payload: Uint8Array, ctx: ArtifactContext): Promise<ArtifactRef> {
      total += payload.length
      if (total > maxBytes)
        throw new Error(
          "memoryArtifactPort: byte budget exceeded - this port is test-only and never for durable use",
        )
      const digest = await sha256Hex(payload)
      const id = refId(digest, ctx)
      store.set(id, payload.slice())
      return { id, digest, bytes: payload.length, mediaType: "application/octet-stream" }
    },
  }
}
