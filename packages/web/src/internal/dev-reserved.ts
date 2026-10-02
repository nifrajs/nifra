/**
 * Specifiers no plugin may match on Bun's dev-server bundler.
 *
 * When a `[serve.static]` plugin's `onResolve` FILTER matches an import, Bun sends it down its plugin
 * path, and a handler that declines does not undo that: Bun then resolves the import on a fallback that
 * breaks a nifra dev page in two ways (Bun 1.3.14 through 1.4.3, oven-sh/bun#19951):
 *
 * - an HTML page's `<script src>` keeps its raw specifier in the HMR module table, so the browser throws
 *   "Failed to load bundled module" and the page never hydrates;
 * - the fallback skips the dev server's built-in modules, so the React Fast Refresh runtime Bun embeds
 *   for an app without `react-refresh` installed fails to resolve, and the dev server does not start.
 *
 * unplugin's Bun adapter registers `onResolve({ filter: /.*\/ })` for every plugin with a `resolveId`
 * hook, so an app plugin can hit both without doing anything unusual. Every plugin nifra hands that
 * bundler registers through {@link reserveDevSpecifiers}.
 */

import type { PluginBuilder } from "bun"

/** The generated client entry, written beside the probe page that loads it. Named so that no import
 * an app writes can be the reserved specifier. */
export const DEV_ENTRY_FILE = "nifra-dev-entry.tsx"

const RESERVED = [`./${DEV_ENTRY_FILE}`, "react-refresh/runtime/index.js"]
const RESERVED_SOURCE = RESERVED.map((specifier) =>
  specifier.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"),
).join("|")

/** `filter`, except that it never matches a reserved specifier. Any other string matches as before. */
export function withoutReservedSpecifiers(filter: RegExp): RegExp {
  // The original runs inside a lookahead from the start, so it still matches anywhere in the string
  // and its own anchors, lookbehinds and backreferences keep their meaning. `g` and `y` are dropped:
  // they make `test` depend on `lastIndex`, which a filter has no use for.
  return new RegExp(
    `^(?!(?:${RESERVED_SOURCE})$)(?=[\\s\\S]*?(?:${filter.source}))`,
    filter.flags.replace(/[gy]/g, ""),
  )
}

/** A view of `build` whose `onResolve` filters never match a reserved specifier. */
export function reserveDevSpecifiers(build: PluginBuilder): PluginBuilder {
  return {
    ...build,
    onResolve(constraints, callback) {
      build.onResolve(
        { ...constraints, filter: withoutReservedSpecifiers(constraints.filter) },
        callback,
      )
      return this
    },
  }
}
