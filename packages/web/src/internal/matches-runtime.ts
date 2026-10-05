/**
 * `useMatches` for every adapter. It reads only {@link RenderProps}, which SSR and the mounted router
 * both build, so server and browser agree. Layout prefixes follow the `filePathToRoutes` grammar.
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
