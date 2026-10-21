import {
  type App,
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

/** One hole's fill, as the PPR runtime keeps it. */
interface HoleFill {
  readonly props?: unknown
  readonly error: boolean
}

interface PprRuntime {
  get(name: string): HoleFill | undefined
  subscribe(name: string, callback: (fill: HoleFill) => void): () => void
}

/** The runtime the shell's inline script defines, when this document has one. */
const pprRuntime = (): PprRuntime | undefined => {
  const runtime: unknown = Reflect.get(globalThis, "__nifraPpr")
  return typeof runtime === "function" && "get" in runtime && "subscribe" in runtime
    ? // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the shell's constant inline runtime defines exactly this shape (internal/ppr/runtime.ts in @nifrajs/web).
      (runtime as PprRuntime)
    : undefined
}

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

/** The slice of a boundary state a hole reads: `ppr` marks a hole the shared shell left open. */
interface HoleState {
  readonly status: "unresolved" | "pending" | "ready" | "error"
  readonly data?: unknown
  readonly ppr?: true
}

export interface HoleProps<Data> {
  readonly of: HoleDefinition<Data>
  readonly state: HoleState | undefined
}

/** The `error` slot is shown when the hole's loader failed. Default: nothing. */
type HoleSlots = SlotsType<{ error?: () => VNodeChild }>

/**
 * Experimental: one `dynamic` boundary of a partially prerendered page.
 *
 * In a shared shell the hole is an empty host Vue never fills or diffs: the PPR runtime puts the
 * server's HTML into it, and an interactive hole then hydrates as its own app from the frame's props.
 * After a client navigation the hole renders like any streamed boundary.
 */
export const Hole = defineComponent(
  <Data>(props: HoleProps<Data>, { slots }: SetupContext<[], HoleSlots>) => {
    const host = shallowRef<HTMLElement | null>(null)
    watch(
      () =>
        [
          props.state?.ppr === true,
          props.of.interactive === true,
          props.of.name,
          props.of.render,
          host.value,
        ] as const,
      ([open, interactive, name, render, element], _, onCleanup) => {
        const runtime = pprRuntime()
        if (!open || !interactive || element === null || runtime === undefined) return
        let app: App | undefined
        const fill = (frame: HoleFill): void => {
          if (frame.error || app !== undefined) return
          // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the server framed these props from this hole's own loader, through its output guard.
          app = createSSRApp({ render: () => render(frame.props as Data) })
          app.config.idPrefix = `nifra-${name}-`
          app.mount(element)
        }
        const now = runtime.get(name)
        const unsubscribe = now === undefined ? runtime.subscribe(name, fill) : undefined
        if (now !== undefined) fill(now)
        onCleanup(() => {
          unsubscribe?.()
          app?.unmount()
        })
      },
      { immediate: true, flush: "post" },
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
