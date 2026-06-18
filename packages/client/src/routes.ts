import type { ContractShape, RegistryFor } from "@nifrajs/core"
import type { Treaty, TreatyFromRegistry } from "./treaty.ts"

/**
 * The typed client proxy for an API type — either a server type (`typeof app`, coupled) or a
 * contract value type (decoupled). Graduating a loader from `typeof app` to a versioned
 * contract is just changing this one type argument; the loader body is identical.
 */
export type ApiProxy<Api> = Api extends ContractShape
  ? TreatyFromRegistry<RegistryFor<Api>>
  : Treaty<Api>

/**
 * Context a route `loader` receives: the route params, the request, a typed in-process `api` (an
 * {@link ApiProxy} for the app contract `Api`), and the platform `env`. Pair with `inProcessClient`.
 */
export interface LoaderArgs<Api, Env = unknown> {
  readonly params: Record<string, string>
  readonly request: Request
  readonly api: ApiProxy<Api>
  /**
   * Platform bindings (Workers `env` — KV/D1/secrets), forwarded from the request `c.env`.
   * `undefined` off-edge (Bun/Node/Deno). Declare the shape via the second type argument —
   * `LoaderArgs<typeof app, Env>` (the same `Env` the backend's `server<Env>()` uses) — to read it
   * typed; otherwise `unknown`. Validate at the trust boundary before use.
   */
  readonly env: Env
  /** `true` when the request carries a valid draft/preview cookie (when the app sets a `draftSecret`;
   * otherwise always `false`). Branch on it to load unpublished content for editors — see `enableDraft`. */
  readonly draft: boolean
}

/** The (awaited) return of a `loader`, for typing a page component's `data` prop. */
export type LoaderData<L> = L extends (...args: never[]) => infer R ? Awaited<R> : never

/**
 * Context a route `action` (a mutation, run on POST) receives — identical to a loader's:
 * route params, the request (read the form/JSON body off this), and the typed in-process
 * `api` + platform `env`. An action returns either data (surfaced to the page as `actionData`) or a
 * `Response` (e.g. a `redirect(...)` for the Post/Redirect/Get pattern).
 */
export type ActionArgs<Api, Env = unknown> = LoaderArgs<Api, Env>

/**
 * The (awaited) data return of an `action`, for typing a page component's `actionData` prop.
 * A `Response` return (redirect/custom) is excluded — it never reaches the component. A
 * `revalidate(paths, data)` wrapper (from `@nifrajs/web`) is transparent: matched structurally (so this
 * stays decoupled from `@nifrajs/web`) and unwrapped to its inner `data` — what the component receives.
 */
export type ActionData<A> = A extends (...args: never[]) => infer R
  ? Awaited<R> extends { readonly __nifraRevalidate: readonly string[]; readonly data: infer D }
    ? Exclude<D, Response>
    : Exclude<Awaited<R>, Response>
  : never

// Why a type annotation, not a `createRoutes()` factory: a module-level factory call defeats
// the bundler's tree-shaking (the call is retained, dragging the loader into the client bundle).
// `LoaderArgs<Api>` is a pure type — it erases — so the loader stays a plain function the client
// build can drop entirely. Bind the contract once with a shared alias:
//
//   // app/loaders.ts
//   export type AppLoader = LoaderArgs<typeof backend>   // coupled
//   export type AppLoader = LoaderArgs<MyContract>       // graduated — same loaders
//
//   // routes/users/[id].tsx
//   export async function loader({ api, params }: AppLoader) { … }   // ctx.api typed
//   export default (props: { data: LoaderData<typeof loader> }) => …  // data typed
