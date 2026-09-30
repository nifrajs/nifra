/**
 * `useMatches` for every adapter: the rendered chain as {@link UIMatch} entries.
 *
 * Kept off `@nifrajs/web/client` so an app that never calls `useMatches` ships none of it. The inputs
 * are all in {@link RenderProps}, which the server builds for SSR and the mounted router builds per
 * navigation, so both sides compute the same matches and hydration agrees.
 *
 * A layout's pathname and params come from its directory, read with the file-name grammar the manifest
 * uses (`filePathToRoutes`): a static folder or a `[param]` (the whole name or part of it) wraps one URL
 * segment, `(group)` and `index` none, `[[optional]]` one when its param is present, `[...rest]` the rest
 * of the path.
 */
import type { RenderProps, UIMatch } from "../render-seam.ts"

const GROUP = /^\(.+\)$/
const OPTIONAL = /^\[\[([A-Za-z_][A-Za-z0-9_]*)\]\]$/
const CATCH_ALL = /^\[\.\.\.([A-Za-z_][A-Za-z0-9_]*)\]$/
const MARKER = /\[([A-Za-z_][A-Za-z0-9_]*)\]/g

/** The matches of one render, outermost layout first. Empty when the render carries no chain. */
export function chainMatches(props: RenderProps): readonly UIMatch[] {
  const chain = props.matchChain
  if (chain === undefined) return []
  const path = props.path ?? ""
  const query = path.indexOf("?")
  const pathname = query === -1 ? path : path.slice(0, query)
  const segments = pathname.split("/").filter((segment) => segment !== "")
  const params = props.params ?? {}
  const last = chain.ids.length - 1
  return chain.ids.map((id, index): UIMatch => {
    const handle = chain.handles[index]
    if (index === last) return { id, pathname, params, data: props.data, handle }
    const owned: Record<string, string> = {}
    let depth = 0
    let rest = false
    const slash = id.lastIndexOf("/")
    for (const part of slash === -1 ? [] : id.slice(0, slash).split("/")) {
      if (part === "index" || GROUP.test(part)) continue
      const optional = OPTIONAL.exec(part)?.[1]
      if (optional !== undefined) {
        const value = params[optional]
        if (value !== undefined) {
          owned[optional] = value
          depth += 1
        }
        continue
      }
      const catchAll = CATCH_ALL.exec(part)?.[1]
      if (catchAll !== undefined) {
        const value = params[catchAll]
        if (value !== undefined) owned[catchAll] = value
        rest = true
        break
      }
      for (const marker of part.matchAll(MARKER)) {
        const name = marker[1] as string
        const value = params[name]
        if (value !== undefined) owned[name] = value
      }
      depth += 1
    }
    return {
      id,
      pathname: rest ? pathname : `/${segments.slice(0, depth).join("/")}`,
      params: owned,
      data: props.layoutData?.[index] ?? null,
      handle,
    }
  })
}
