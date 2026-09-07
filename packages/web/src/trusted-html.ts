/**
 * A framework-neutral trust boundary for the small set of adapters that intentionally inject HTML.
 *
 * This is a type-level brand, not a sanitizer. Callers must sanitize untrusted input with a
 * well-reviewed allowlist sanitizer before calling {@link trustHtml}; build-time markdown and
 * application-owned templates may use it directly after review. Keeping the constructor explicit
 * makes every raw-HTML sink audit-greppable and prevents an ordinary string from type-checking by
 * accident.
 */

declare const TRUSTED_HTML_BRAND: unique symbol

export type TrustedHtml = string & { readonly [TRUSTED_HTML_BRAND]: "trusted-html" }

/** Alias for integrations whose sanitizer returns a separately named safe value. */
export type SanitizedHtml = TrustedHtml

/** Mark already-sanitized or application-owned HTML for an intentional raw-HTML adapter sink. */
export function trustHtml(value: string): TrustedHtml {
  if (typeof value !== "string") throw new TypeError("trusted HTML must be a string")
  return value as TrustedHtml
}

/** Explicit alias for callers that want the sanitized-content vocabulary at the call site. */
export const sanitizedHtml = trustHtml
