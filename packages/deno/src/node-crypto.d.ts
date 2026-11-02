// The one node:crypto export the static reader calls, so `deno check` needs no @types/node.
import type { ContentHash } from "./generated/static-file.ts"

export declare function createHash(algorithm: "sha256"): ContentHash
