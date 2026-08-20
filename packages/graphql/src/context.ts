/**
 * The context-injection seam - the one thing a hand-rolled `app.all('/graphql', yoga.fetch)` mount
 * cannot do. A GraphQL executor builds an opaque `contextValue` from the raw `Request`; it never sees
 * the nifra request context (auth subject, params, env, `waitUntil`). This contract lets a resolver's
 * `contextValue` be derived from whatever the surrounding nifra handler already resolved.
 *
 * The builder is called once per operation (per HTTP request, or once per WS `Subscribe` message),
 * before `execute`/`subscribe`. It receives the raw `Request` and, on the HTTP path, the nifra route
 * context `c` when the endpoint is mounted with `mountGraphql` (which has `c` in scope); on the WS path
 * it receives the upgrade request. Return the object your resolvers read as their third argument.
 *
 * MOAT NOTE: this seam only *passes through* context the host already owns. It never persists it. A
 * tenant-aware or durable resolver-context store is an operated concern and lives outside this package.
 */

/** What the builder is handed. `request` is always present; `nifra` is the route context when known. */
export interface GraphqlContextInput<Env = unknown> {
  readonly request: Request
  /**
   * The nifra route context (`c`) when the endpoint was mounted via `mountGraphql`, otherwise
   * `undefined` (e.g. `respondGraphql` called standalone, or the WS transport before a route context
   * exists). Typed loosely on purpose so this package never imports core's context type at the value
   * level - keeping the peer dependency truly optional.
   */
  readonly nifra?: NifraContextLike<Env>
}

/**
 * The subset of a nifra route context this package surfaces to a resolver-context builder. Structural,
 * so the real `c` satisfies it without a nominal import. Kept to the non-body accessors a resolver
 * legitimately needs; the raw body belongs to the GraphQL executor, not the builder.
 */
export interface NifraContextLike<Env = unknown> {
  readonly req: Request
  readonly params: Record<string, string>
  readonly env: Env
  readonly signal: AbortSignal
  readonly waitUntil: (promise: Promise<unknown>) => void
}

/**
 * Build the resolver `contextValue` for one operation. Sync or async; a throw is reported as a GraphQL
 * error envelope rather than crashing the transport. Omit it and resolvers get `contextValue: {}`.
 */
export type GraphqlContextBuilder<Context = unknown, Env = unknown> = (
  input: GraphqlContextInput<Env>,
) => Context | Promise<Context>

/** Resolve a context builder to a concrete value, defaulting to an empty object. */
export async function buildContext<Context, Env>(
  builder: GraphqlContextBuilder<Context, Env> | undefined,
  input: GraphqlContextInput<Env>,
): Promise<Context> {
  if (builder === undefined) return {} as Context
  return await builder(input)
}
