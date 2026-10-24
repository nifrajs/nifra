import { type HoleHost, holeHost, initialHtml } from "@nifrajs/web/internal/hole-runtime"
import { createElement, type ReactNode, type RefObject, useEffect, useRef, useState } from "react"
import { hydrateRoot } from "react-dom/client"
import { Await } from "./await.ts"
import { inActivity } from "./slot.ts"

/** The fields of a route's boundary declaration a hole renders from. */
export interface HoleDefinition<Data> {
  readonly name: string
  readonly render: (data: Data) => ReactNode
  readonly fallback?: ReactNode
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

interface Parked {
  readonly element: Element
  readonly driven: HoleHost
}

// The host effect's cleanup: a host a kept page hides is parked for the page's return, not disposed.
const leaving =
  (
    driver: RefObject<HoleHost | undefined>,
    parked: RefObject<Parked | undefined>,
    element: Element,
    driven: HoleHost,
  ) =>
  (): void => {
    driver.current = undefined
    if (driven.park()) parked.current = { element, driven }
    else driven.dispose()
  }

// React writes an `<Activity>` as a pair of comments around its content, after any `<title>` the
// content renders. A host's HTML without that pair (rendered by a React that has no `<Activity>`)
// hydrates without one: React never finishes hydrating an `<Activity>` the HTML holds no boundary for.
const activityBoundary = (target: Element): boolean => {
  let first = target.firstChild
  while (first instanceof Element && first.localName === "title") first = first.nextSibling
  const last = target.lastChild
  return (
    first !== last &&
    first instanceof Comment &&
    first.data === "&" &&
    last instanceof Comment &&
    last.data === "/&"
  )
}

export interface HoleProps<Data> {
  readonly of: HoleDefinition<Data>
  readonly state: HoleState | undefined
  /** Shown when the hole's loader failed. Default: nothing. */
  readonly error?: ReactNode
}

/**
 * Experimental: one `dynamic` or `shared` boundary of a partially prerendered page.
 *
 * In a shared shell the hole is an empty host React never fills or diffs: the PPR runtime puts the
 * server's HTML into it, and an interactive hole then hydrates as its own root from the frame's props.
 * When the page reloads, after an action or a live change, the host takes the new fill in place: an
 * interactive root re-renders with the new props and keeps its state. After a client navigation the
 * hole renders like any streamed boundary.
 */
export function Hole<Data>(props: HoleProps<Data>): ReactNode {
  const { of: hole, state } = props
  const host = useRef<HTMLDivElement>(null)
  const driver = useRef<HoleHost | undefined>(undefined)
  const parked = useRef<Parked | undefined>(undefined)
  const open = state?.ppr === true
  const [initial] = useState(() => ({ __html: initialHtml(state?.fill) }))
  const interactive = hole.interactive === true
  const { name, render } = hole
  useEffect(() => {
    const element = host.current
    if (!open || element === null) return
    // A kept page shown again: `Activity` cleaned the effects up as it hid the page, but the host
    // kept its root, and its state.
    const back = parked.current
    parked.current = undefined
    if (back?.element === element) {
      back.driven.unpark()
      driver.current = back.driven
      return leaving(driver, parked, element, back.driven)
    }
    back?.driven.dispose()
    const driven = holeHost(
      name,
      element,
      interactive
        ? (target, data) => {
            let props = data
            let hidden = false
            // In an `<Activity>` when the server rendered the HTML in one: hidden with its page,
            // the root's effects clean up and its state stays.
            const paused = activityBoundary(target)
            const view = (): ReactNode => {
              // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the server framed these props from this hole's own loader, through its output guard.
              const content = render(props as Data)
              return paused ? inActivity(hidden, content) : content
            }
            const root = hydrateRoot(target, view(), { identifierPrefix: `nifra-${name}-` })
            return {
              update: (next) => {
                props = next
                root.render(view())
                return true
              },
              hide: (next) => {
                if (!paused || hidden === next) return
                hidden = next
                root.render(view())
              },
              dispose: (leaving) => {
                const unmount = (): void => {
                  root.unmount()
                  // The `<Activity>` boundary's comments, which React leaves behind.
                  if (paused) target.replaceChildren()
                }
                // Unmounting a root while the parent commits warns in React; the next task is outside it.
                if (leaving) setTimeout(unmount, 0)
                else unmount()
              },
            }
          }
        : undefined,
    )
    driver.current = driven
    return leaving(driver, parked, element, driven)
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
      // biome-ignore lint/security/noDangerouslySetInnerHtml: the server-checked HTML of a blocking render's fill, else empty, fixed at first render; it only stops React from reconciling the host the PPR runtime fills.
      dangerouslySetInnerHTML: initial,
      suppressHydrationWarning: true,
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
