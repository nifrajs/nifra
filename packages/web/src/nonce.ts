/** Context supplied while resolving a document's CSP nonce. */
export interface NonceContext<Env = unknown> {
  readonly request: Request
  readonly env: Env
}

/** Generate a nonce for one request, or return `undefined` to keep the document nonce-free. */
export type NonceGenerator<Env = unknown> = (
  context: NonceContext<Env>,
) => string | undefined | Promise<string | undefined>

/** Context supplied to the optional Content-Security-Policy header callback. */
export interface NonceHeaderContext {
  readonly nonce: string
  readonly request: Request
  readonly response: Response
}

/** Return the complete Content-Security-Policy value for a nonce-bearing document. */
export type NonceHeader = (context: NonceHeaderContext) => string | undefined

/**
 * A request-aware nonce resolver. It is callable so existing `createWebApp({ nonce })` code can pass
 * it directly. When created with a `header` callback, `createWebApp` also installs its response hook
 * automatically and applies that callback's CSP value to the same request that received the nonce.
 */
export interface NonceResolver<Env = unknown> extends NonceGenerator<Env> {
  /** Read the currently resolved nonce for a request, if one has been generated. */
  readonly get?: (request: Request) => string | undefined
  /** Internal integration seam used by `createWebApp` when a header callback was supplied. */
  readonly onResponse?: (response: Response, request: Request) => Response
}

export interface CreateNonceResolverOptions<Env = unknown> {
  /** Custom nonce generator. The default is a fresh CSP base64-compatible nonce per request. */
  readonly generate?: NonceGenerator<Env>
  /** Build the complete CSP value. App-specific sources remain the caller's responsibility. */
  readonly header?: NonceHeader
}

/**
 * Create a request-memoized CSP nonce resolver for `createWebApp`.
 *
 * ```ts
 * const nonce = createNonceResolver({
 *   header: ({ nonce }) => `default-src 'self'; script-src 'self' 'nonce-${nonce}'`,
 * })
 * const app = createWebApp({ adapter, manifest, clientEntry, nonce })
 * ```
 *
 * A nonce is generated only when the page executor asks for one. Data-mode/API responses never ask,
 * so the response hook has no value to attach and leaves those responses without a CSP nonce header.
 */
export function createNonceResolver<Env = unknown>(
  options: CreateNonceResolverOptions<Env> = {},
): NonceResolver<Env> {
  const values = new WeakMap<Request, string>()
  const pending = new WeakMap<Request, Promise<string | undefined>>()
  // CSP nonce-source values use the base64-value grammar. A UUID contains hyphens, so remove them
  // before emitting it; the remaining 122 random bits are sufficient for a per-response nonce and
  // stay valid across browsers and all fetch runtimes without a Node-only encoder.
  const generate = options.generate ?? (() => crypto.randomUUID().replaceAll("-", ""))

  const resolve = (context: NonceContext<Env>): string | Promise<string | undefined> => {
    const existing = values.get(context.request)
    if (existing !== undefined) return existing
    const ongoing = pending.get(context.request)
    if (ongoing !== undefined) return ongoing
    const generated = (async (): Promise<string | undefined> => {
      const value = await generate(context)
      if (value === undefined) return undefined
      if (value.trim() === "") {
        throw new TypeError("[nifra/web] createNonceResolver generated an empty CSP nonce")
      }
      values.set(context.request, value)
      return value
    })()
    pending.set(context.request, generated)
    generated.then(
      () => pending.delete(context.request),
      () => pending.delete(context.request),
    )
    return generated
  }

  const get = (request: Request): string | undefined => values.get(request)
  if (options.header === undefined) return Object.assign(resolve, { get })

  const onResponse = (response: Response, request: Request): Response => {
    const nonce = values.get(request)
    values.delete(request)
    if (nonce === undefined) return response
    const value = options.header?.({ nonce, request, response })
    if (value === undefined) return response
    const headers = new Headers(response.headers)
    headers.set("content-security-policy", value)
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }
  return Object.assign(resolve, { get, onResponse })
}
