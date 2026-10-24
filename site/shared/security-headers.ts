/**
 * The headers every nifra.dev response carries. Pages applies `_headers` (written from this by
 * build.ts) only to the files it serves itself, so `_worker.ts` adds the same set to its answers.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  // The home page frames /play, so a same-origin parent stays allowed.
  "Content-Security-Policy": "frame-ancestors 'self'",
  "X-Frame-Options": "SAMEORIGIN",
}
