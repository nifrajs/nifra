/**
 * Shared fixtures for the Workers cold-start benchmark. Kept tiny and dependency-free so every
 * worker entry pays for its framework and nothing else.
 */

/** The one predicate every framework's POST branch shares, so the rows validate identical
 *  semantics and only the adapter's plumbing differs (mirrors bench/lambda/_drive.ts). */
export function isUser(v: unknown): v is { name: string; age: number } {
  return (
    typeof v === "object" &&
    v !== null &&
    "name" in v &&
    typeof (v as { name: unknown }).name === "string" &&
    "age" in v &&
    typeof (v as { age: unknown }).age === "number"
  )
}
