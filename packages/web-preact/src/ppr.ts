import { type HoleHost, holeHost } from "@nifrajs/web/internal/hole-runtime"
import { type ComponentChildren, createElement, hydrate, render as renderInto } from "preact"
import { useEffect, useRef } from "preact/hooks"
import { Await } from "./await.ts"
import { idScope } from "./id-scope.ts"

/** The fields of a route's boundary declaration a hole renders from. */
export interface HoleDefinition<Data> {
  readonly name: string
  readonly render: (data: Data) => ComponentChildren
  readonly fallback?: ComponentChildren
  readonly interactive?: boolean
}

/** The slice of a boundary state a hole reads: `ppr` marks a hole the shared shell left open, and
 * `fill` that host's refill when the page reloads. */
interface HoleState {
  readonly status: "unresolved" | "pending" | "ready" | "error"
  readonly data?: unknown
  readonly ppr?: true
  readonly fill?: unknown
}

export interface HoleProps<Data> {
  readonly of: HoleDefinition<Data>
  readonly state: HoleState | undefined
  /** Shown when the hole's loader failed. Default: nothing. */
  readonly error?: ComponentChildren
}

const EMPTY_HTML = { __html: "" }

/**
 * Experimental: one `dynamic` or `shared` boundary of a partially prerendered page.
 *
 * In a shared shell the hole is an empty host Preact never fills or diffs: the PPR runtime puts the
 * server's HTML into it, and an interactive hole then hydrates as its own root from the frame's props.
 * When the page reloads, after an action or a live change, the host takes the new fill in place: an
 * interactive root re-renders with the new props and keeps its state. After a client navigation the
 * hole renders like any streamed boundary.
 */
export function Hole<Data>(props: HoleProps<Data>): ComponentChildren {
  const { of: hole, state } = props
  const host = useRef<HTMLDivElement>(null)
  const driver = useRef<HoleHost | undefined>(undefined)
  const open = state?.ppr === true
  const interactive = hole.interactive === true
  const { name, render } = hole
  useEffect(() => {
    const element = host.current
    if (!open || element === null) return
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the server framed these props from this hole's own loader, through its output guard.
    const view = (data: unknown) => idScope(render(data as Data), `nifra-${name}-`)
    const driven = holeHost(
      name,
      element,
      interactive
        ? (target, data) => {
            hydrate(view(data), target)
            return {
              update: (next) => {
                renderInto(view(next), target)
                return true
              },
              dispose: () => renderInto(null, target),
            }
          }
        : undefined,
    )
    driver.current = driven
    return () => {
      driver.current = undefined
      driven?.dispose()
    }
  }, [open, interactive, name, render])
  const fill = open ? state?.fill : undefined
  useEffect(() => {
    if (fill !== undefined) driver.current?.refill(fill)
  }, [fill])
  if (open) {
    return createElement("div", {
      ref: host,
      "data-nifra-hole": name,
      "aria-busy": "true",
      // Always empty; it only stops Preact from diffing the children the PPR runtime puts in.
      dangerouslySetInnerHTML: EMPTY_HTML,
    })
  }
  if (state === undefined) return hole.fallback ?? null
  if (state.status === "error") return props.error ?? null
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a ready state carries this boundary's loader output, through its output guard.
  if (state.status === "ready") return render(state.data as Data)
  // A streamed hole's data is its deferred loader output, whatever status the payload names.
  if (state.data === undefined) return hole.fallback ?? null
  return Await<Data>({
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a pending streamed state carries this boundary's deferred loader output.
    resolve: state.data as Data,
    fallback: hole.fallback ?? null,
    errorFallback: () => props.error ?? null,
    children: render,
  })
}
