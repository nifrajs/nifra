/**
 * A framework-neutral trust boundary for the small set of adapters that intentionally inject HTML.
 *
 * `TrustedHtml` is a type-level brand, not a sanitizer. Callers must sanitize untrusted input with a
 * well-reviewed allowlist sanitizer before calling {@link trustHtml}; build-time markdown and
 * application-owned templates may use it directly after review. Keeping the constructor explicit
 * makes every raw-HTML sink audit-greppable and prevents an ordinary string from type-checking by
 * accident.
 */

declare const TRUSTED_HTML_BRAND: unique symbol
declare const SANITIZED_HTML_BRAND: unique symbol

export type TrustedHtml = string & { readonly [TRUSTED_HTML_BRAND]: "trusted-html" }

/** HTML returned by an explicit, caller-supplied sanitizer. It is also trusted by the adapters. */
export type SanitizedHtml = TrustedHtml & { readonly [SANITIZED_HTML_BRAND]: "sanitized-html" }

/** The only contract a project-specific, allowlist-based HTML sanitizer must satisfy. */
export type HtmlSanitizer = (value: string) => string

/** Mark already-sanitized or application-owned HTML for an intentional raw-HTML adapter sink. */
export function trustHtml(value: string): TrustedHtml {
  if (typeof value !== "string") throw new TypeError("trusted HTML must be a string")
  return value as TrustedHtml
}

/**
 * Run untrusted markup through an explicit sanitizer before it reaches a raw-HTML adapter.
 *
 * Nifra deliberately does not bundle a sanitizer: applications choose the maintained allowlist
 * appropriate to their runtime and content policy. Requiring the sanitizer as an argument prevents
 * `sanitizedHtml(value)` from silently becoming an alias for the unsafe trust operation.
 */
export function sanitizeHtml(value: string, sanitizer: HtmlSanitizer): SanitizedHtml {
  if (typeof value !== "string") throw new TypeError("HTML to sanitize must be a string")
  if (typeof sanitizer !== "function") throw new TypeError("an HTML sanitizer is required")
  const sanitized = sanitizer(value)
  if (typeof sanitized !== "string") throw new TypeError("HTML sanitizer must return a string")
  return sanitized as SanitizedHtml
}

/** Explicit sanitized-content vocabulary for callers and security audits. */
export const sanitizedHtml = sanitizeHtml
