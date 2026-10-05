import type { ContractShape, RegistryFor } from "@nifrajs/core/contract"
import type { CookieOptions, InferOutput, StandardSchemaV1 } from "@nifrajs/core/server"
import type { Treaty, TreatyFromRegistry } from "./treaty.ts"

/**
 * The typed client proxy for an API type - either a server type (`typeof app`, coupled) or a
 * contract value type (decoupled). Graduating a loader from `typeof app` to a versioned
 * contract is just changing this one type argument; the loader body is identical.
 */
export type ApiProxy<Api> = Api extends ContractShape
  ? TreatyFromRegistry<RegistryFor<Api>>
  : Treaty<Api>

/**
 * Response controls a loader or action reaches as `ctx.set` - the page counterpart of a route
 * handler's `c.set`. Write before the loader or action returns; a write from a deferred promise that
 * settles later throws.
 */
export interface LoaderResponseControls {
  /**
   * Headers for the rendered document (`cache-control`, `x-robots-tag`, `link`, ...). A layout's
   * headers are applied first, then the page's, then the action's, so the most specific writer wins a
   * name. They are not applied to a redirect, a status page, an error page, or a navigation data
   * response. `content-type`, `set-cookie`, `location`, transport headers, and the `x-nifra-` prefix
   * are refused.
   */
  readonly headers: Record<string, string>
  /**
   * Queue a `Set-Cookie`, with the same secure defaults as `c.set.cookie`
   * (`HttpOnly; Secure; SameSite=Lax; Path=/`). The cookie rides every outcome - the document, a
   * navigation data response, a redirect, a status or error page - and makes the response
   * `cache-control: private, no-store`.
   */
  cookie(name: string, value: string, options?: CookieOptions): void
  /** Queue a cookie deletion. Match the `path`/`domain` the cookie was set with. */
  deleteCookie(name: string, options?: Pick<CookieOptions, "path" | "domain">): void
}

/**
 * Context a route `loader` receives: the route params, the request, a typed in-process `api` (an
 * {@link ApiProxy} for the app contract `Api`), and the platform `env`. Pair with `inProcessClient`.
 */
export interface LoaderArgs<Api, Env = unknown, Search = undefined> {
  readonly params: Record<string, string>
  readonly request: Request
  /** Alias of {@link request} - the same `Request`. Mirrors a route handler's `c.req`, so the same name
   * works in loaders/actions and routes (no `ctx.request` vs `c.req` mismatch). */
  readonly req: Request
  readonly api: ApiProxy<Api>
  /**
   * Platform bindings (Workers `env` - KV/D1/secrets), forwarded from the request `c.env`.
   * `undefined` off-edge (Bun/Node/Deno). Declare the shape via the second type argument -
   * `LoaderArgs<typeof app, Env>` (the same `Env` the backend's `server<Env>()` uses) - to read it
   * typed; otherwise `unknown`. Validate at the trust boundary before use.
   */
  readonly env: Env
  /** `true` when the request carries a valid draft/preview cookie (when the app sets a `draftSecret`;
   * otherwise always `false`). Branch on it to load unpublished content for editors - see `enableDraft`. */
  readonly draft: boolean
  /** The URL search params, validated server-side (fails closed to the schema's defaults, so it is safe
   * to use directly). Declare a route `searchSchema` and pass its type as the third argument -
   * `LoaderArgs<typeof app, Env, typeof searchSchema>` - to read it typed; otherwise a raw
   * `Record<string, unknown>` of the parsed query. */
  readonly search: Search extends StandardSchemaV1
    ? InferOutput<Search> extends Record<string, unknown>
      ? InferOutput<Search>
      : never
    : Record<string, unknown>
  /** Response headers and cookies for this page request: `ctx.set.headers["cache-control"] = ...`,
   * `ctx.set.cookie("theme", "dark")`. */
  readonly set: LoaderResponseControls
}

/**
 * The app's registered types. `nifra types` writes `.nifra/types/register.d.ts`, which fills it in
 * from `backend/app.ts`, so a route's generated `Route.LoaderArgs` types `api` without the route
 * importing the backend:
 *
 *     declare module "@nifrajs/client" { interface Register { backend: typeof backend } }
 *
 * `env` may be registered the same way, for the platform bindings `ctx.env` carries.
 */
// biome-ignore lint/suspicious/noEmptyInterface: filled in by declaration merging
export interface Register {}

/** The registered backend (`Register["backend"]`), or `unknown` before one is registered. */
export type RegisteredBackend = Register extends { readonly backend: infer Backend }
  ? Backend
  : unknown

/** The registered platform bindings (`Register["env"]`), or `unknown`. */
export type RegisteredEnv = Register extends { readonly env: infer Env } ? Env : unknown

/**
 * What a route module's output schema lets through to the browser: the output type of its `Name`
 * export (`loaderOutput`, `actionOutput`), or `null` when the module declares none - a loader without
 * one sends no data.
 */
export type OutputOf<Module, Name extends string> = Module extends { readonly [K in Name]: infer S }
  ? S extends StandardSchemaV1
    ? InferOutput<S>
    : never
  : null

/** The `searchSchema` a route's frontend half declares, or `undefined`. */
export type SearchSchemaOf<Module> = Module extends { readonly searchSchema: infer S }
  ? S
  : undefined

/** A route's loader or action context: its own `params`, and `api` typed by the registered backend. */
export type RouteLoaderArgs<Params, Search = undefined> = Omit<
  LoaderArgs<RegisteredBackend, RegisteredEnv, Search>,
  "params"
> & { readonly params: Params }

/** The (awaited) return of a `loader`, for typing a page component's `data` prop. */
export type LoaderData<L> = L extends (...args: never[]) => infer R ? Awaited<R> : never

/**
 * Context a route `action` (a mutation, run on POST) receives - identical to a loader's:
 * route params, the request (read the form/JSON body off this), and the typed in-process
 * `api` + platform `env`. An action returns either data (surfaced to the page as `actionData`) or a
 * `Response` (e.g. a `redirect(...)` for the Post/Redirect/Get pattern).
 */
export type ActionArgs<Api, Env = unknown, Search = undefined> = LoaderArgs<Api, Env, Search>

/**
 * The (awaited) data return of an `action`, for typing a page component's `actionData` prop.
 * A `Response` return (redirect/custom) is excluded - it never reaches the component. A
 * `revalidate(paths, data)` wrapper (from `@nifrajs/web`) is transparent: matched structurally (so this
 * stays decoupled from `@nifrajs/web`) and unwrapped to its inner `data` - what the component receives.
 */
export type ActionData<A> = A extends (...args: never[]) => infer R
  ? // `infer D` makes the check distribute, so an action mixing `revalidate(...)` and plain returns
    // unwraps each branch.
    Awaited<R> extends infer D
    ? D extends { readonly __nifraRevalidate: readonly string[]; readonly data: infer W }
      ? Exclude<W, Response>
      : Exclude<D, Response>
    : never
  : never

// Why a type annotation, not a `createRoutes()` factory: a module-level factory call defeats
// the bundler's tree-shaking (the call is retained, dragging the loader into the client bundle).
// `LoaderArgs<Api>` is a pure type - it erases - so the loader stays a plain function the client
// build can drop entirely. Bind the contract once with a shared alias:
//
//   // app/loaders.ts
//   export type AppLoader = LoaderArgs<typeof backend>   // coupled
//   export type AppLoader = LoaderArgs<MyContract>       // graduated - same loaders
//
//   // routes/users/[id].tsx
//   export async function loader({ api, params }: AppLoader) { … }   // ctx.api typed
//   export default (props: { data: LoaderData<typeof loader> }) => …  // data typed
