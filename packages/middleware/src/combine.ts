import { definePlugin, type Middleware, type NifraPlugin } from "@nifrajs/core/server"

export type Composable = Middleware | NifraPlugin

function applyAll(app: Parameters<NifraPlugin>[0], items: readonly Composable[]) {
  let current = app
  for (const item of items) {
    // The public `use` overload accepts both shapes; this helper intentionally preserves runtime
    // composition while leaving advanced context type threading to direct `.use(...)` chains.
    current = current.use(item as never)
  }
  return current
}

/** Compose middleware/plugins into one reusable bundle. Individual named plugins still dedupe. */
export function combine(...items: readonly Composable[]): NifraPlugin {
  return ((app) => applyAll(app, items)) as NifraPlugin
}

/** Compose middleware/plugins into one idempotent named bundle. */
export function namedCombine(name: string, ...items: readonly Composable[]): NifraPlugin {
  if (name.trim() === "") throw new Error("namedCombine: name is empty")
  return definePlugin(name, (app) => applyAll(app, items))
}
