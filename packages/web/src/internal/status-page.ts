/**
 * The terminal-status helpers and their brand, free of server imports: `@nifrajs/web/client` re-exports
 * them for route helpers the browser also loads, which the root entry would drag `node:crypto` into.
 */

/** Derived from the `Headers` constructor rather than the DOM lib's `HeadersInit`: `@nifrajs/web`
 * is consumed from DOM-free programs (the root tsconfig runs `types: ["bun"]`), and naming the DOM
 * type here would break their build. Same workaround as `SSEInit.headers` in core. */
export type HeadersLike = ConstructorParameters<typeof Headers>[0]

/**
 * Brand marking a `Response` as a **terminal-status signal** rather than a response to serve verbatim.
 *
 * A loader that throws a bare `Response` has always been passed straight through - that is how
 * `throw redirect(...)` works, and apps rely on it. So "render the `_404` boundary at 404" cannot be
 * expressed by throwing a plain `Response`: the framework would have no way to tell it apart from a
 * hand-rolled body the app wants served exactly as written. The brand is that distinction, and
 * checking it *before* the pass-through is what keeps every existing throw working unchanged.
 *
 * `Symbol.for` matches core's `RESPONSE_RESULT`: a registry symbol survives two copies of this module,
 * which a `unique symbol` would not - and a duplicate-install turning a 404 into a raw 404 body would
 * be a maddening bug to trace.
 */
export const STATUS_SIGNAL = Symbol.for("nifra.web.status-signal")

export interface StatusSignal extends Response {
  readonly [STATUS_SIGNAL]: { readonly status: number; readonly headers?: HeadersLike }
}

export function isStatusSignal(value: unknown): value is StatusSignal {
  return value instanceof Response && STATUS_SIGNAL in value
}

function statusSignal(status: number, options: StatusPageOptions): never {
  if (!Number.isInteger(status) || status < 400 || status > 599) {
    throw new Error(
      `[nifra/web] statusPage(${JSON.stringify(status)}) must be an integer 4xx or 5xx status. Use redirect() for 3xx, and return data for a successful render.`,
    )
  }
  const response = new Response(null, { status })
  // Non-enumerable so the brand never lands in a structured clone or a JSON log of the response.
  Object.defineProperty(response, STATUS_SIGNAL, {
    value: { status, ...(options.headers !== undefined ? { headers: options.headers } : {}) },
    enumerable: false,
  })
  throw response
}

/** Options shared by {@link notFound}, {@link gone}, and {@link statusPage}. */
export interface StatusPageOptions {
  /**
   * Extra headers for the rendered response - `cache-control` above all.
   *
   * The defaults differ by status for a reason: a 404 may be a race with publication, so it wants a
   * short TTL, while a 410 is a promise that the URL is permanently gone and can be cached hard.
   * Getting this wrong is the difference between a crawler dropping a dead URL and re-fetching it
   * for weeks.
   */
  readonly headers?: HeadersLike
}

/**
 * Render the nearest `_404` page at status **404**. `throw` it from a loader when the record does not
 * exist.
 *
 * This is the fix for the soft 404: a matched route whose loader finds nothing has otherwise no way to
 * answer 404, so the path of least resistance is to return empty data and render "not found" inside a
 * **200**. That looks correct in a browser and is invisible in review, which is why it ships and stays
 * shipped - while search engines penalise it and keep the dead URL indexed.
 *
 * Returns `never`: these throw, so a loader narrows without a redundant `return`, and the type states
 * the thing the "loaders `throw` redirect, actions `return` it" rule already trips people on.
 */
export function notFound(options: StatusPageOptions = {}): never {
  return statusSignal(404, options)
}

/**
 * Render a terminal page at status **410 Gone**. `throw` it from a loader for a record that existed and
 * was deliberately removed - a withdrawn listing, a deleted post.
 *
 * 410 is not a pedantic 404: it tells a crawler to **drop** the URL rather than re-fetch it for weeks
 * on the assumption the 404 was transient. Uses `_410.tsx` if the app has one, otherwise `_404`.
 */
export function gone(options: StatusPageOptions = {}): never {
  return statusSignal(410, options)
}

/**
 * Render a terminal page at any 4xx/5xx status - the escape hatch behind {@link notFound} and
 * {@link gone} (402, 451, …). Uses `_<status>.tsx` if present, otherwise `_404`.
 */
export function statusPage(status: number, options: StatusPageOptions = {}): never {
  return statusSignal(status, options)
}
