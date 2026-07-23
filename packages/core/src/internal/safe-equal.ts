/**
 * Constant-time string comparison for credential-shaped values - lease tokens, token hashes, and
 * binding digests.
 *
 * `a !== b` returns as soon as it finds a differing character, so how long it takes reveals how much
 * of a guess was correct. That is only exploitable when an attacker can submit guesses and measure,
 * which is not the case on every path here - but these values are credentials, the comparison is on
 * the verification path, and doing it correctly costs nothing. Doing it inconsistently is what makes
 * the one place that matters easy to miss.
 *
 * Length is compared first, so a length difference is still observable. Every value compared through
 * this helper is fixed-width by construction (a UUID, a SHA-256 hex/base64url digest), so length
 * carries no secret. Content comparison always visits every character.
 *
 * Synchronous on purpose: the callers are store transitions and lease checks that are themselves
 * synchronous. A hash-then-compare variant (which would also hide length) is available as
 * `timingSafeEqualString` in `@nifrajs/middleware`, but it is async and would force those paths async.
 */
export function safeEqual(a: string | undefined, b: string | undefined): boolean {
  // Accepts `undefined` so optional binding fields keep their exact `!==` semantics at call sites:
  // absent equals absent, and absent never equals present. Neither branch is secret-bearing.
  if (a === undefined || b === undefined) return a === b
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
