/**
 * Plugin definers and their types. A plugin is a function that augments an app (calling
 * `use`/`derive`/`decorate` and/or registering routes) and returns it; these helpers attach a name
 * for idempotent dedupe and pin the type-threading so `.use()` preserves the caller's typed server.
 */
import type { AnyServer } from "./server.ts"

/**
 * A nifra **plugin**: a function that augments an app - calling `use`/`derive`/`decorate` and/or
 * registering routes - and returns it. Because `derive`/`decorate` are type-threaded, an **inline**
 * `app.use((a) => a.derive(...).decorate(...))` carries the added context to handlers defined after
 * it (the `use` overload is generic over the concrete `this`). Wrap with {@link definePlugin} to
 * attach a name for idempotent dedupe (applying the same named plugin twice - e.g. transitively - is
 * a no-op).
 */
export type NifraPlugin<In extends AnyServer = AnyServer, Out extends AnyServer = In> = ((
  app: In,
) => Out) & { readonly pluginName?: string }

/**
 * A named type-identity plugin built with {@link defineIdentityPlugin}. It returns the same concrete
 * server type it receives, preserving the caller's typed registry and context across `.use()` while
 * still allowing the plugin to register runtime hooks or handlers.
 */
export type IdentityPlugin = (<S extends AnyServer>(app: S) => S) & {
  readonly pluginName?: string
}

/**
 * Name + ergonomics for a plugin that **adds typed context** (`derive`/`decorate`). `app.use(myPlugin)`
 * applies it once; a second `use` of the same name is skipped (idempotent), so plugins can depend on each
 * other without double-registering hooks.
 *
 * ```ts
 * export const requestId = definePlugin("requestId", (app) => app.derive(() => ({ requestId: uuid() })))
 * app.use(requestId)   // downstream handlers see c.requestId
 * ```
 *
 * FOOTGUN: only use this for a plugin that adds context. For a plugin that **mounts routes/hooks but adds
 * NO context** (an auth router, an audit logger), use {@link defineRouterPlugin} ({@link defineIdentityPlugin}).
 * `definePlugin((app) => app.get(...))` infers `app: Server<any, any>`, so `.use()` returns `Server<any, any>`
 * and your whole typed client silently collapses to `any` - no type error, no runtime error.
 */
export function definePlugin<In extends AnyServer, Out extends AnyServer>(
  name: string,
  apply: (app: In) => Out,
): NifraPlugin<In, Out> {
  return Object.assign(apply, { pluginName: name }) as NifraPlugin<In, Out>
}

/**
 * Define a type-**identity** plugin: it registers routes/hooks as a side effect but returns the app with
 * its `Registry` + `Context` UNCHANGED. Use this (not {@link definePlugin}) for any plugin that doesn't
 * add context types - e.g. one mounting an auth handler. It threads the caller's *concrete* server type
 * through `use`, so routes declared after `app.use(plugin)` keep their types.
 *
 * Why a dedicated helper: `definePlugin((app) => app)` infers `app: Server<any, any>`, so `use` returns
 * `Server<any, any>` and the whole typed client collapses to `any`. The explicit generic return type here
 * (which a plain `Object.assign` can't preserve) is what keeps `use` returning the precise server type.
 *
 * ```ts
 * export const audit = defineIdentityPlugin("audit", (app) => app.onResponse(logResponse))
 * const api = server().get("/a", h).use(audit).get("/b", h) // /a AND /b stay typed
 * ```
 */
export function defineIdentityPlugin(
  name: string,
  apply: <S extends AnyServer>(app: S) => S,
): IdentityPlugin {
  return Object.assign(apply, { pluginName: name }) as IdentityPlugin
}

/**
 * Alias of {@link defineIdentityPlugin} with a name that says what it's FOR: a plugin that **mounts
 * routes/hooks but adds no context type** (an auth router, an audit logger). Use this - not
 * {@link definePlugin} - for any such plugin, or the typed client silently collapses to `any`. The
 * "identity" in {@link defineIdentityPlugin} refers to the type-identity it preserves; `defineRouterPlugin`
 * is the same thing under a clearer name.
 *
 * Mount routes as a **side effect**, then return the app unchanged (registering via `.get`/`.post` would
 * change the type away from the identity `S`; the mounted routes run but aren't in the caller's typed
 * registry - that's the trade that keeps everything else typed):
 *
 * ```ts
 * export const scim = defineRouterPlugin("scim", (app) => {
 *   app.get("/scim/v2/Users", listUsers) // side effect: mounted at runtime
 *   return app                           // return S unchanged → routes added after .use(scim) stay typed
 * })
 * const api = server().get("/a", h).use(scim).get("/b", h) // /a AND /b stay typed
 * ```
 */
export const defineRouterPlugin: typeof defineIdentityPlugin = defineIdentityPlugin
