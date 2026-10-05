import type { StandardSchemaV1 } from "@nifrajs/core/server"
import { BACKEND_ROUTE_EXPORTS } from "../src/manifest.ts"

/**
 * An output schema that accepts any value, for fixtures whose subject is not the data guard. It
 * exposes no JSON Schema, so the guard keeps whatever `validate` returns: the value itself.
 */
export const anyOutput: StandardSchemaV1 = {
  "~standard": { version: 1, vendor: "test", validate: (value) => ({ value }) },
}

const ROUTE_FILE = /\.(?:tsx|jsx|svelte|vue|mdx)$/

/** Whether a fixture path is a route's backend half. */
export const isBackendHalf = (file: string): boolean => file.includes(".backend.")

/**
 * Split single-file route fixtures into the two halves nifra loads: each backend-only export moves to
 * the file's `x.backend.ts`, the way `nifra migrate layout` splits a real route. Lets a test state a
 * route as one object while the manifest sees the real two-file shape. A loader or action with no
 * output schema gets {@link anyOutput}.
 */
export function splitRouteHalves<Module extends object>(
  modules: Readonly<Record<string, Module>>,
): Record<string, Module> {
  const out: Record<string, Module> = {}
  for (const [file, module] of Object.entries(modules)) {
    if (!ROUTE_FILE.test(file)) {
      out[file] = module
      continue
    }
    const front: Record<string, unknown> = {}
    const back: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(module)) {
      ;(BACKEND_ROUTE_EXPORTS.has(name) ? back : front)[name] = value
    }
    if (back.loader !== undefined) back.loaderOutput ??= anyOutput
    if (back.action !== undefined) back.actionOutput ??= anyOutput
    out[file] = front as Module
    if (Object.keys(back).length > 0) out[file.replace(ROUTE_FILE, ".backend.ts")] = back as Module
  }
  return out
}
