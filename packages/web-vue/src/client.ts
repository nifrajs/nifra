import type { MountRouterOptions, RenderProps } from "@nifrajs/web"
/**
 * @nifrajs/web-vue/client - Vue client runtime. `hydrate` hydrates a single SSR'd route; `mountRouter`
 * hydrates a stateful Router whose root component subscribes to the agnostic store (a `shallowRef`
 * fed by `router.subscribe`) and re-renders the matched chain on every client navigation (no full
 * reload). `createSSRApp(...).mount` reconciles against the SSR markup (Vue's hydration). Kept in its
 * own entry so server code stays out of the client bundle.
 */
import {
  type Component,
  computed,
  createSSRApp,
  createVNode,
  defineComponent,
  Fragment,
  h,
  onScopeDispose,
  provide,
  shallowRef,
  type VNode,
} from "vue"
import { compose, pageNode } from "./compose.ts"
import { setMountedRouter } from "./fetcher.ts"
import { PROPS_KEY, SEARCH_KEY } from "./route-context.ts"
import { routeProps } from "./route-props.ts"

// The `_error` boundary chain element - defined in its own module, re-exported here so nifra's client
// codegen resolves it from `@nifrajs/web-vue/client` alongside `mountRouter`.
export { errorBoundary } from "./error.ts"

const rootFor = (render: () => unknown): Component =>
  defineComponent({ setup: () => () => render() })

function assuranceWarning(): ((message: string) => void) | undefined {
  const value = (globalThis as unknown as Record<PropertyKey, unknown>)[
    Symbol.for("nifra.hydration.assurance")
  ]
  if (typeof value !== "object" || value === null) return undefined
  const callback = (value as { onWarning?: unknown }).onWarning
  return typeof callback === "function" ? (callback as (message: string) => void) : undefined
}

/** Hydrate a server-rendered Vue layout `chain` (with the loader `props`) inside `container`. */
export interface HydrationAssuranceOptions {
  readonly onWarning?: (message: string) => void
}

export function hydrate(
  chain: readonly unknown[],
  props: RenderProps,
  container: unknown,
  options?: HydrationAssuranceOptions,
): void {
  const warning = options?.onWarning ?? assuranceWarning()
  const app = createSSRApp(rootFor(() => compose(chain, props)))
  if (warning !== undefined) app.config.warnHandler = (message) => warning(message)
  app.mount(container as Element)
}

/** Testing hook used by verification runners to observe Vue warnings and identity. */
export const hydrationAssuranceHook = Object.freeze({
  framework: "vue" as const,
  runtimeIdentity: (): object => createSSRApp,
})

// Keep actual route vnodes in slots: KeepAlive/Transition must see the page/layout, not a shared
// routing component. For an unchanged layout chain, a fragment block patches the mounted route
// components directly; stable slots let Vue skip layouts whose own props did not change.
type ChainBlock = VNode & { dynamicChildren: VNode[] | null }
function chainRenderer(): (chain: readonly unknown[], props: RenderProps) => VNode {
  let previous: VNode[] = []
  let block: ChainBlock | undefined
  let slots: { child: VNode; render: () => VNode; uses: number }[] = []
  return (chain, props) => {
    const last = chain.length - 1
    const stable =
      previous.length === chain.length &&
      slots.every((slot) => slot.uses <= 1) &&
      previous.every(
        (node, i) =>
          node.type === chain[i] &&
          node.component !== null &&
          node.component.isMounted &&
          !node.component.isUnmounted &&
          (i === last ||
            (node.props?.data === (props.layoutData?.[i] ?? null) &&
              node.props?.boundaries === props.boundaries)),
      )
    const nodes: VNode[] = []
    let child = pageNode(chain[last], props)
    // FULL_PROPS: block patching must still compare the page's props (data, pending, actionData…).
    child.patchFlag = 16
    nodes[last] = child
    let sharedPrefix = 0
    while (sharedPrefix < last && previous[sharedPrefix]?.type === chain[sharedPrefix])
      sharedPrefix++
    slots = slots.slice(0, sharedPrefix)
    for (let i = last - 1; i >= 0; i--) {
      let slot = slots[i]
      if (slot === undefined) {
        const held = {
          child,
          uses: 0,
          render: (): VNode => {
            held.uses++
            return held.child
          },
        }
        slot = slots[i] = held
      }
      slot.child = child
      // A slot rendered more than once owns multiple component instances; patch it hierarchically. The
      // count restarts on every router render, so a layout's own re-renders between them never add up.
      slot.uses = 0
      child = h(
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: chain entries are the route modules' default Vue component exports
        chain[i] as Component,
        { data: props.layoutData?.[i] ?? null, boundaries: props.boundaries },
        { default: slot.render, $stable: stable },
      )
      nodes[i] = child
    }
    // 64 is Vue's STABLE_FRAGMENT patch flag. On a chain change (or an unmounted child held by a
    // transition/boundary), use normal hierarchical patching so slot consumers own the switch.
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Vue creates dynamicChildren on every vnode; its public VNode type omits this block-patching field
    const next = createVNode(Fragment, null, [child], 64) as ChainBlock
    if (block !== undefined) block.dynamicChildren = stable ? [...previous].reverse() : null
    next.dynamicChildren = stable ? [...nodes].reverse() : null
    previous = nodes
    block = next
    return next
  }
}

/**
 * Hydrate a stateful Vue Router. A `shallowRef` holds the store snapshot; `router.subscribe` writes
 * each new snapshot into it, so the root re-renders the matched layout chain on every store change -
 * client navigations swap routes without a full reload. The initial snapshot matches the SSR markup.
 */
export function mountRouter(options: MountRouterOptions): void {
  const { router, routes, searchSchemas, matchChains, container } = options
  setMountedRouter(router) // expose it to useFetcher/useFetchers (same page, client-only)
  const Root = defineComponent({
    setup() {
      const state = shallowRef(router.snapshot())
      const unsubscribe = router.subscribe(() => {
        state.value = router.snapshot()
      })
      onScopeDispose(unsubscribe)
      const props = computed(() => routeProps(state.value, searchSchemas, matchChains))
      // The provider in server compose renders a fragment around the chain. Provide its same
      // context here so this fragment can also carry Vue's block optimization, without extra DOM.
      provide(PROPS_KEY, props)
      provide(
        SEARCH_KEY,
        computed(() => props.value.search ?? {}),
      )
      const render = chainRenderer()
      return () => render(routes[state.value.routeId] ?? [], props.value)
    },
  })
  const app = createSSRApp(Root)
  const warning = assuranceWarning()
  if (warning !== undefined) app.config.warnHandler = (message) => warning(message)
  app.mount(container as Element)
}
