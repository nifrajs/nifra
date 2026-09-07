/**
 * How framework-owned stylesheets are made active during the first document load.
 *
 * `blocking` is the backwards-compatible default. `deferred` is intended for an aggregate
 * stylesheet: the document fetches it with `media="print"`, then the generated client promotes it
 * to `media="all"` after the resource settles and before mounting the app.
 */
export type CssLoadingMode = "blocking" | "deferred"

/** The default remains the ordinary render-blocking stylesheet link. */
export const DEFAULT_CSS_LOADING: CssLoadingMode = "blocking"

/** Runtime validation for the Vite CSS output switch. `undefined` means Vite's default (`true`). */
export function normalizeCssCodeSplit(value: unknown): boolean {
  if (value === undefined) return true
  if (typeof value === "boolean") return value
  throw new TypeError(
    `[nifra/web] cssCodeSplit must be a boolean when provided, received ${JSON.stringify(value)}`,
  )
}

/** Runtime validation for JavaScript callers, generated manifests, and hand-authored integrations. */
export function normalizeCssLoading(value: unknown): CssLoadingMode {
  if (value === "blocking" || value === "deferred") return value
  throw new TypeError(
    `[nifra/web] cssLoading must be "blocking" or "deferred", received ${JSON.stringify(value)}`,
  )
}

/**
 * Guard the only Vite combination that would claim to solve the stylesheet-insertion regression while
 * leaving the cause in place. A deferred split build can still attach CSS when a prefetched lazy chunk
 * evaluates, so it must fail closed instead of producing a misleadingly healthy deployment.
 */
export function assertCssLoadingCompatible(
  cssCodeSplit: boolean,
  cssLoading: CssLoadingMode,
): void {
  if (cssLoading !== "deferred" || !cssCodeSplit) return
  throw new Error(
    '[nifra/web] cssLoading: "deferred" requires cssCodeSplit: false. Vite can otherwise inject ' +
      "stylesheets when prefetched lazy chunks evaluate, reintroducing page-wide style/layout work.",
  )
}
