/**
 * The `solid-refresh` ↔ Bun-dev-server bridge, client-side. Loaded only by a dev-server client bundle
 * (`solidBunPlugin("dom")` resolves the `nifra:solid-hot` specifier its Babel pass emits); never part of
 * `nifra build` output.
 *
 * `solid-refresh` expects a Vite-shaped `import.meta.hot` handed to it as a VALUE. Bun does not have one:
 * it rewrites `import.meta.hot.<prop>` at bundle time and substitutes a proxy that throws
 * (`import.meta.hot.<prop> cannot be used indirectly`) for every other use - so passing the object to a
 * library function fails on the first property read, whichever property it is. This module supplies the
 * value-shaped object instead, built from direct member accesses the plugin emits at the call site.
 *
 * Two of the three pieces need more than a pass-through:
 *
 * - `data` is where `solid-refresh` keeps the previous version's component registry, so it has to be the
 *   SAME object across every version of a module. Bun's own `data` is a field on a per-version module
 *   record, so it is not usable for that; the store below is keyed by module URL and lives in this
 *   module, which no edit invalidates.
 * - `invalidate` is not implemented in Bun's HMR runtime (it throws). It is the escape hatch
 *   `solid-refresh` takes when a component's shape changed too much to patch in place, and a full reload
 *   is exactly the right answer there - so that is what it does.
 */

import { $$refresh } from "solid-refresh"

/**
 * Registry store per module URL - see the note above on why Bun's own `hot.data` cannot serve.
 *
 * On `globalThis`, not in module scope: Bun re-evaluates an updated module's imports along with it, so
 * this very module is re-instantiated during an update and a module-scoped Map would come back empty
 * halfway through. The symptom of getting that wrong is not a lost registry but an infinite one -
 * `patchRegistry` then compares a registry against itself, points a component's signal at its own proxy,
 * and the next render recurses until the stack blows.
 */
const STORES = Symbol.for("nifra.solid-refresh.stores")

type StoreHost = typeof globalThis & {
  [STORES]?: Map<string, Record<string, unknown>>
}

function store(moduleUrl: string): Record<string, unknown> {
  const host = globalThis as StoreHost
  host[STORES] ??= new Map<string, Record<string, unknown>>()
  const stores = host[STORES]
  let data = stores.get(moduleUrl)
  if (data === undefined) {
    data = {}
    stores.set(moduleUrl, data)
  }
  return data
}

/** The subset of `solid-refresh`'s hot interface its `"esm"` bundler mode actually touches. */
interface SolidHot {
  readonly data: Record<string, unknown>
  accept(callback: (module: unknown) => void): void
  invalidate(): void
  decline(): void
}

/**
 * Run `solid-refresh`'s update handshake for one module.
 *
 * `moduleUrl` identifies the module across versions; `accept` is a closure the plugin emits around
 * `import.meta.hot.accept`, which is the only form Bun's bundler will rewrite. `registry` is the
 * component registry this version of the module built.
 */
export function refresh(
  moduleUrl: string,
  accept: (callback: (module: unknown) => void) => void,
  registry: unknown,
): void {
  const reload = (): void => {
    location.reload()
  }
  const hot: SolidHot = { data: store(moduleUrl), accept, invalidate: reload, decline: reload }
  // `$$refresh`'s published signature is a discriminated tuple over every bundler mode it supports, so
  // the "esm" arm cannot be selected by a cast on the hot object alone. The mode string and the shape
  // above are what pin it; the call itself is what has to be re-typed.
  const esmRefresh = $$refresh as unknown as (mode: "esm", hot: SolidHot, registry: unknown) => void
  esmRefresh("esm", hot, registry)
}
