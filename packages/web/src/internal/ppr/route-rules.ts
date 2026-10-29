import type { BoundaryRegistration } from "../../boundary.ts"
import type { RouteEntry, RouteModule } from "../../manifest.ts"
import type { LoadedLayoutModules } from "../render-document.ts"
import { isHole, serverHoleComponent } from "./contract.ts"
import type { ResolvedPprOptions } from "./options.ts"

/**
 * The declared variations `search` selects. A parameter given twice, or a value outside its set,
 * selects nothing, so every spelling of one choice maps to one shell.
 */
export function variationsOf(
  declared: RouteModule["shellVariations"],
  search: string,
): Readonly<Record<string, string>> {
  const lists = declared?.search
  if (lists === undefined || search === "") return {}
  const query = new URLSearchParams(search)
  const chosen: Record<string, string> = {}
  for (const [name, allowed] of Object.entries(lists)) {
    const values = query.getAll(name)
    const value = values[0]
    if (values.length === 1 && value !== undefined && allowed.includes(value)) chosen[name] = value
  }
  return chosen
}

/** The PPR eligibility rules a route's own files cannot check: its layouts and boundary modes. */
export function assertPprRoute(
  route: RouteEntry,
  layouts: LoadedLayoutModules,
  boundaries: readonly BoundaryRegistration[],
  limits: ResolvedPprOptions,
): void {
  // `compileShells` refuses the same chain at startup; this catches a record made from other files.
  layouts.forEach((layout, index) => {
    if (layout.loader !== undefined && layout.gate !== true) {
      throw new Error(
        `[nifra/web] ppr: route "${route.id}" has a shellLoader, but its layout "${route.layoutIds[index]}" has a loader that is not a gate. A layout loader reads the request, so its output cannot be in a shared shell`,
      )
    }
  })
  let holes = 0
  for (const boundary of boundaries) {
    if (!isHole(boundary)) continue
    holes++
    if (typeof boundary.load !== "function") {
      throw new Error(
        `[nifra/web] ppr: boundary "${boundary.name}" of route "${route.id}" has no boundaryLoaders entry; a hole is filled from its own loader`,
      )
    }
    if (
      serverHoleComponent(boundary.render) !== undefined &&
      (boundary.mode !== "dynamic" || boundary.interactive === true)
    ) {
      throw new Error(
        `[nifra/web] ppr: boundary "${boundary.name}" of route "${route.id}" shows a server component, so it must be a dynamic hole that is not interactive: the component runs for each visitor, and its client islands hydrate`,
      )
    }
    const { timeout } = boundary
    const max = limits.maxHoleTimeoutMs
    if (timeout !== undefined && !(Number.isInteger(timeout) && timeout >= 1 && timeout <= max)) {
      throw new RangeError(
        `[nifra/web] ppr: boundary "${boundary.name}" of route "${route.id}" has timeout ${String(timeout)}; it must be a whole number of milliseconds from 1 to ${max}`,
      )
    }
  }
  if (holes === 0 || holes > limits.maxHolesPerRoute) {
    throw new RangeError(
      `[nifra/web] ppr: route "${route.id}" has a shellLoader and ${holes} dynamic or shared boundaries; it needs 1 to ${limits.maxHolesPerRoute}. A page with no per-visitor or fast-changing part needs no shell: prerender it or give it \`revalidate\``,
    )
  }
}
