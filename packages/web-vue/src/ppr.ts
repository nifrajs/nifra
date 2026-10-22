import { type HoleHost, holeHost } from "@nifrajs/web/internal/hole-runtime"
import {
  createSSRApp,
  defineComponent,
  h,
  type SetupContext,
  type SlotsType,
  shallowRef,
  type VNodeChild,
  watch,
} from "vue"
import { Await } from "./await.ts"
import { freshVNode } from "./fresh-vnode.ts"

/**
 * The fields of a route's boundary declaration a hole renders from: `h()` output, not templates.
 * `render` is a method so a definition fits `h(Hole, ...)`, which cannot carry its data type.
 */
export interface HoleDefinition<Data> {
  readonly name: string
  render(data: Data): VNodeChild
  readonly fallback?: VNodeChild
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
}

/** The `error` slot is shown when the hole's loader failed. Default: nothing. */
type HoleSlots = SlotsType<{ error?: () => VNodeChild }>

/**
 * Experimental: one `dynamic` or `shared` boundary of a partially prerendered page.
 *
 * In a shared shell the hole is an empty host Vue never fills or diffs: the PPR runtime puts the
 * server's HTML into it, and an interactive hole then hydrates as its own app from the frame's props.
 * When the page reloads, after an action or a live change, the host takes the new fill in place: an
 * interactive app re-renders with the new props and keeps its state. After a client navigation the
 * hole renders like any streamed boundary.
 */
export const Hole = defineComponent(
  <Data>(props: HoleProps<Data>, { slots }: SetupContext<[], HoleSlots>) => {
    const host = shallowRef<HTMLElement | null>(null)
    let driver: HoleHost | undefined
    // One getter per value: a getter returning a fresh array, or a shallow ref among the sources, makes
    // every state a change and would remake the host's app on each refill.
    watch(
      [
        () => props.state?.ppr === true,
        () => props.of.interactive === true,
        () => props.of.name,
        () => props.of.render,
        () => host.value,
      ] as const,
      ([open, interactive, name, render, element], _, onCleanup) => {
        if (!open || element === null) return
        const driven = holeHost(
          name,
          element,
          interactive
            ? (target, data) => {
                const current = shallowRef(data)
                // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the server framed these props from this hole's own loader, through its output guard.
                const app = createSSRApp({ render: () => render(current.value as Data) })
                app.config.idPrefix = `nifra-${name}-`
                app.mount(target)
                return {
                  update: (next) => {
                    current.value = next
                    return true
                  },
                  dispose: () => app.unmount(),
                }
              }
            : undefined,
        )
        driver = driven
        onCleanup(() => {
          driver = undefined
          driven?.dispose()
        })
      },
      { immediate: true, flush: "post" },
    )
    watch(
      () => (props.state?.ppr === true ? props.state.fill : undefined),
      (fill) => {
        if (fill !== undefined) driver?.refill(fill)
      },
      { flush: "post" },
    )
    return () => {
      const { of: hole, state } = props
      if (state?.ppr === true) {
        // No children: hydration and later renders leave the ones the PPR runtime puts in alone.
        return h("div", { ref: host, "data-nifra-hole": hole.name, "aria-busy": "true" })
      }
      if (state === undefined) return freshVNode(hole.fallback)
      if (state.status === "error") return slots.error?.()
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a ready state carries this boundary's loader output, through its output guard.
      if (state.status === "ready") return hole.render(state.data as Data)
      // A streamed hole's data is its deferred loader output, whatever status the payload names.
      if (state.data === undefined) return freshVNode(hole.fallback)
      return h(
        Await,
        { resolve: state.data },
        {
          // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a pending streamed state carries this boundary's deferred loader output.
          default: (value: unknown) => hole.render(value as Data),
          fallback: () => freshVNode(hole.fallback),
          error: () => slots.error?.(),
        },
      )
    }
  },
  {
    name: "Hole",
    props: ["of", "state"],
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Vue's slot typing marker; `slots` is type-only and Vue never reads its value.
    slots: Object as HoleSlots,
  },
)
