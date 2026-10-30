import { type HoleState, initialHtml } from "@nifrajs/web/internal/hole-runtime"
import { createComponent, createMemo, type JSX, untrack } from "solid-js"
import { Dynamic, isServer } from "solid-js/web"
import { Await } from "./await.ts"
import { clientHost } from "./ppr-client.ts"

/**
 * The fields of a route's boundary declaration a hole renders from. `fallback` is a function: JSX
 * evaluated at import is one DOM node, so every place that shows it would take it from the last.
 */
export interface HoleDefinition<Data> {
  readonly name: string
  readonly render: (data: Data) => JSX.Element
  readonly fallback?: () => JSX.Element
  readonly interactive?: boolean
}

export interface HoleProps<Data> {
  readonly of: HoleDefinition<Data>
  readonly state: HoleState | undefined
  /** Shown when the hole's loader failed. Default: nothing. */
  readonly error?: JSX.Element
}

/** An open hole's host: claimed by its hydration key like any element, never given children in the
 * browser. On the server it holds a blocking render's HTML. */
function openHost<Data>(hole: HoleDefinition<Data>, fill: () => unknown): JSX.Element {
  const attributes = { "data-nifra-hole": hole.name, "aria-busy": "true" }
  if (isServer) {
    const initial = initialHtml(fill())
    return createComponent(Dynamic, {
      component: "div",
      ...attributes,
      ...(initial === "" ? {} : { innerHTML: initial }),
    })
  }
  return clientHost(hole.name, hole.render, hole.interactive === true, attributes, fill)
}

/**
 * One `dynamic` or `shared` boundary of a partially prerendered page.
 *
 * In a shared shell the hole is an empty host Solid never fills: the PPR runtime puts the server's
 * HTML into it, and an interactive hole then hydrates as its own root from the frame's props. When the
 * page reloads, after an action or a live change, the same host takes the new fill in place: an
 * interactive root gets the new props through its store and keeps its state. After a client
 * navigation the hole renders like any streamed boundary.
 */
export function Hole<Data>(props: HoleProps<Data>): JSX.Element {
  const open = createMemo(() => props.state?.ppr === true)
  const fill = createMemo(() => (open() ? props.state?.fill : undefined))
  const view = createMemo(() => {
    // Only `open` is read for a host, so a refill keeps it.
    if (open()) return untrack(() => openHost(props.of, fill))
    const hole = props.of
    const state = props.state
    if (state === undefined) return untrack(() => hole.fallback?.())
    if (state.status === "error") return props.error
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a ready state carries this boundary's loader output, through its output guard.
    if (state.status === "ready") return untrack(() => hole.render(state.data as Data))
    // A streamed hole's data is its deferred loader output, whatever status the payload names.
    if (state.data === undefined) return untrack(() => hole.fallback?.())
    return untrack(() =>
      createComponent(Await<Data>, {
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a pending streamed state carries this boundary's deferred loader output.
        resolve: state.data as Data,
        get fallback() {
          return hole.fallback?.()
        },
        errorFallback: () => props.error,
        children: hole.render,
      }),
    )
  })
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion lint/plugin/noChainedTypeAssertions: Solid inserts an accessor reactively, as its own Show returns one; its JSX.Element type leaves functions out.
  return view as unknown as JSX.Element
}
