import {
  type AnyServer,
  defineIdentityPlugin,
  type IdentityPlugin,
  type Middleware,
} from "@nifrajs/core/server"

export type Composable = Middleware | IdentityPlugin

function applyAll<S extends AnyServer>(app: S, items: readonly Composable[]): S {
  let current: AnyServer = app
  for (const item of items) {
    // The public `use` overload accepts both shapes; this helper intentionally preserves runtime
    // composition while leaving advanced context type threading to direct `.use(...)` chains.
    current = current.use(item as never)
  }
  return current as S
}

/**
 * Compose middleware/plugins into one reusable bundle. Individual named plugins still dedupe.
 *
 * The bundle is a type **identity**: everything it contains runs, but context a member adds via
 * `derive`/`decorate` is not threaded to the caller's handler types (there is no way to sum unknown
 * members' context at the type level). Apply such a member with its own `.use(...)` instead.
 */
export function combine(...items: readonly Composable[]): IdentityPlugin {
  // No `pluginName`: an unnamed bundle is applied every time rather than deduped.
  return <S extends AnyServer>(app: S): S => applyAll(app, items)
}

/** Compose middleware/plugins into one idempotent named bundle. */
export function namedCombine(name: string, ...items: readonly Composable[]): IdentityPlugin {
  if (name.trim() === "") throw new Error("namedCombine: name is empty")
  return defineIdentityPlugin(name, (app) => applyAll(app, items))
}
