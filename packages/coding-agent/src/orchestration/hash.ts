/**
 * Content-addressing helpers shared by the orchestration module: a SHA-256 hex digest over bytes,
 * and canonical JSON so a digest is stable across key order.
 */

import { sha256Hex as sharedSha256Hex } from "@nifrajs/utils/hash"

export { canonicalJson } from "@nifrajs/utils/canonical-json"
export { sha256Hex } from "@nifrajs/utils/hash"

const encoder = new TextEncoder()

/** SHA-256 hex of a UTF-8 string. */
export function sha256HexOf(text: string): Promise<string> {
  return sharedSha256Hex(encoder.encode(text))
}
