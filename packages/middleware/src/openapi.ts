import { definePlugin } from "@nifrajs/core"
// The OpenAPI generator only — `@nifrajs/schema/openapi` is pure (no TypeBox runtime), so the openapi()
// plugin gets full `t`-schema introspection without pulling the `t` builder into every consumer.
import { toOpenAPI } from "@nifrajs/schema/openapi"

/** A registered route as seen by {@link buildOpenApiDocument} — structurally a `@nifrajs/core`
 * `RouteDescriptor` (so `app.routes()` is passed straight through). */
export interface RouteLike {
  readonly method: string
  readonly path: string
  // `| undefined` (not just `?`) so a core `RouteDescriptor` — whose `schema` is a *required*
  // `RouteSchema | undefined` — is assignable under `exactOptionalPropertyTypes`.
  readonly schema?:
    | { readonly body?: unknown; readonly query?: unknown; readonly response?: unknown }
    | undefined
}

export interface OpenApiInfo {
  readonly title?: string
  readonly version?: string
  readonly description?: string
}

export interface OpenApiServer {
  readonly url: string
  readonly description?: string
}

export interface OpenApiTag {
  readonly name: string
  readonly description?: string
}

/** A security requirement: scheme name → required scopes (`[]` = no scopes). */
export type SecurityRequirement = Readonly<Record<string, readonly string[]>>

/** Scalar API-reference UI options. */
export interface OpenApiUiOptions {
  /** Where to serve the UI page. Default `"/reference"`. */
  readonly path?: string
  /** Page title. Defaults to `info.title`. */
  readonly title?: string
  /** The Scalar script URL (loaded from a CDN). Default jsDelivr's `@scalar/api-reference`. */
  readonly cdn?: string
}

export interface OpenApiOptions {
  readonly info?: OpenApiInfo
  readonly servers?: readonly OpenApiServer[]
  /** Tag definitions (top-level `tags`). Reference them from an operation via `operations`. */
  readonly tags?: readonly OpenApiTag[]
  /** Reusable security schemes → `components.securitySchemes` (e.g. `{ bearer: { type: "http", scheme: "bearer" } }`). */
  readonly securitySchemes?: Readonly<Record<string, Record<string, unknown>>>
  /** Document-wide security requirement; override per-operation via `operations`. */
  readonly security?: readonly SecurityRequirement[]
  /** Where the plugin serves the document. Default `"/openapi.json"`. */
  readonly path?: string
  /** Exclude routes from the document (the doc path itself is always excluded). */
  readonly exclude?: (route: { readonly method: string; readonly path: string }) => boolean
  /** Per-operation overrides keyed by `"GET /users/:id"`, shallow-merged over the generated skeleton —
   * the escape hatch for rich request/response schemas, tags, and per-op security (Standard Schema
   * can't be introspected). */
  readonly operations?: Readonly<Record<string, Record<string, unknown>>>
  /** Also serve a Scalar API-reference UI page rendering the spec (`true` → `/reference`). */
  readonly ui?: boolean | OpenApiUiOptions
}

/**
 * Build an OpenAPI 3.1 document from a route list. Delegates to `@nifrajs/schema`'s `toOpenAPI`, so a
 * route validated with `t` (TypeBox) emits full field-level request/query/response schemas plus
 * `$ref`-reused `components.schemas`; a BYO Standard Schema (zod/valibot/arktype) exposes no portable
 * JSON-Schema form, so its body/response is omitted (supply it via `options.operations`). Path params,
 * wildcards, tags, security, and servers always emit. Exported so you can also generate the doc at
 * build time (write it to disk in CI) without booting the server.
 */
export function buildOpenApiDocument(
  routes: readonly RouteLike[],
  options: OpenApiOptions = {},
): Record<string, unknown> {
  const docPath = options.path ?? "/openapi.json"
  // toOpenAPI has no exclude hook, so filter here: never document the doc endpoint itself, then apply
  // the caller's exclude predicate.
  const included = routes.filter(
    (route) =>
      route.path !== docPath &&
      options.exclude?.({ method: route.method, path: route.path }) !== true,
  )
  // toOpenAPI duck-types an "app" by a `routes()` method (its `isApp`); this shim lets the runtime
  // plugin reuse the rich generator over a plain route list without holding a live Server reference.
  // The cast is required because toOpenAPI's parameter is a nominal `ContractShape | Server` union,
  // and the shim only satisfies it structurally.
  const appShim = { routes: () => included } as unknown as Parameters<typeof toOpenAPI>[0]
  return toOpenAPI(appShim, {
    title: options.info?.title ?? "nifra API",
    version: options.info?.version ?? "0.0.0",
    ...(options.info?.description !== undefined ? { description: options.info.description } : {}),
    ...(options.servers !== undefined ? { servers: options.servers } : {}),
    ...(options.tags !== undefined ? { tags: options.tags } : {}),
    ...(options.security !== undefined ? { security: options.security } : {}),
    ...(options.securitySchemes !== undefined ? { securitySchemes: options.securitySchemes } : {}),
    ...(options.operations !== undefined ? { operations: options.operations } : {}),
  }) as unknown as Record<string, unknown>
}

const SCALAR_CDN = "https://cdn.jsdelivr.net/npm/@scalar/api-reference"

/**
 * Minimal HTML that mounts the Scalar API reference against a spec URL. The interpolated values are
 * dev-provided config (not request input), but they're still escaped so a stray quote or `<` can't
 * break the markup.
 */
function scalarPage(specUrl: string, title: string, cdn: string): string {
  const attr = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
  const text = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;")
  return `<!doctype html>
<html>
  <head>
    <title>${text(title)}</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <script id="api-reference" data-url="${attr(specUrl)}"></script>
    <script src="${attr(cdn)}"></script>
  </body>
</html>`
}

/**
 * Serve an OpenAPI 3.1 document (a structural subset — see {@link buildOpenApiDocument}) at
 * `options.path` (default `/openapi.json`), generated from the app's registered routes. Generation is
 * **lazy + memoized**: it reads `app.routes()` on the first request, by which point every route is
 * registered — so the plugin's own position in the chain doesn't matter.
 *
 * Pass `ui: true` (or `ui: { path, title, cdn }`) to also serve a Scalar API-reference page (default
 * `/reference`) that renders the spec. The page loads Scalar from a CDN; pin/self-host via `ui.cdn`,
 * and remember to allow that origin if you ship a `script-src` Content-Security-Policy.
 *
 * ```ts
 * app.use(openapi({ info: { title: "My API", version: "1.0.0" }, ui: true }))
 * ```
 */
export function openapi(options: OpenApiOptions = {}) {
  const docPath = options.path ?? "/openapi.json"
  const ui: OpenApiUiOptions | undefined =
    options.ui === true ? {} : options.ui === false ? undefined : options.ui
  const uiPath = ui !== undefined ? (ui.path ?? "/reference") : undefined
  let cached: string | undefined
  let uiCached: string | undefined
  return definePlugin("openapi", (app) => {
    // Capture `app` (the same mutable builder every later `.get()`/`.post()` registers on) and read its
    // routes lazily, at request time — so all routes exist regardless of where the plugin sits.
    app.register("GET", docPath, undefined, () => {
      cached ??= JSON.stringify(
        buildOpenApiDocument(app.routes(), {
          ...options,
          path: docPath,
          // Don't document the UI page itself (the doc path is already excluded by buildOpenApiDocument).
          exclude: (route) => route.path === uiPath || options.exclude?.(route) === true,
        }),
      )
      return new Response(cached, { headers: { "content-type": "application/json" } })
    })
    if (ui !== undefined && uiPath !== undefined) {
      const title = ui.title ?? options.info?.title ?? "nifra API"
      const cdn = ui.cdn ?? SCALAR_CDN
      app.register("GET", uiPath, undefined, () => {
        uiCached ??= scalarPage(docPath, title, cdn)
        return new Response(uiCached, { headers: { "content-type": "text/html; charset=utf-8" } })
      })
    }
    return app
  })
}
