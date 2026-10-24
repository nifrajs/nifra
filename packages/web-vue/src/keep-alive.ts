/**
 * @nifrajs/web-vue/keep-alive - the client mount of an app with a `keepAlive` route, which the generated
 * client entry imports in place of `@nifrajs/web-vue/client` (whose exports it carries).
 *
 * Vue keeps hidden pages with its own `<KeepAlive>`, driven by the router: each level of the slot tree
 * (`slotTree`) renders one `<KeepAlive>` around the slot it shows, whose `include` names the kept
 * slots at that level, so a page the router drops is unmounted. Each slot is its own named component;
 * no wrapper elements are rendered, so the document hydrates as the server rendered it. `KeepAlive`
 * moves a hidden page out of the document but loses its inner scroll, so the mount notes the scroll
 * and focus before Vue hides a page and puts them back when it is shown again.
 */
import type { MountRouterOptions, RenderProps, RouterState } from "@nifrajs/web"
import {
  type KeepAliveRouter,
  type KeepAliveTable,
  noteKeptView,
  PAGE_HIDE_EVENT,
  PAGE_SHOW_EVENT,
  type PageView,
  rememberView,
  type SlotNode,
  slotTree,
} from "@nifrajs/web/keep-alive"
import {
  type Component,
  type ComponentInternalInstance,
  computed,
  createSSRApp,
  defineComponent,
  getCurrentInstance,
  h,
  isVNode,
  KeepAlive,
  onActivated,
  onScopeDispose,
  onUnmounted,
  provide,
  ref,
  shallowRef,
  type VNode,
} from "vue"
import { pageNode } from "./compose.ts"
import { setMountedRouter } from "./fetcher.ts"
import { PAGE_KEY, type PageSlot } from "./page-visibility.ts"
import { PROPS_KEY, RouteContextProvider, SEARCH_KEY } from "./route-context.ts"
import { routeProps } from "./route-props.ts"

export * from "./client.ts"
export { onPageHide, onPageShow, usePageVisibility } from "./page-visibility.ts"

/** `mountRouter`'s options in a keep-alive app: the generated entry adds which slots are kept. */
export interface KeepAliveMountOptions extends MountRouterOptions {
  readonly router: KeepAliveRouter
  readonly keepAlive: KeepAliveTable
}

interface Kept {
  readonly slot: PageSlot
  readonly instance: ComponentInternalInstance
  view: PageView | undefined
  showing: boolean
}

// The top-level elements a slot renders, through components and fragments.
const elementsOf = (vnode: VNode): Element[] => {
  if (vnode.component !== null && vnode.component !== undefined)
    return elementsOf(vnode.component.subTree)
  if (vnode.el instanceof Element) return [vnode.el]
  if (!Array.isArray(vnode.children)) return []
  return vnode.children.flatMap((child) => (isVNode(child) ? elementsOf(child) : []))
}

const deactivated = (instance: ComponentInternalInstance): boolean => {
  for (let at: ComponentInternalInstance | null = instance; at !== null; at = at.parent)
    if (at.isDeactivated) return true
  return false
}

const keptNodes = (nodes: readonly SlotNode[], into: SlotNode[] = []): SlotNode[] => {
  for (const node of nodes) {
    if (node.wrapped) into.push(node)
    if (node.children !== undefined) keptNodes(node.children, into)
  }
  return into
}

// The page's own chain from `depth` on: an `_error` boundary, then the page.
const pageChain = (chain: readonly unknown[], depth: number, props: RenderProps): VNode => {
  if (depth >= chain.length - 1) return pageNode(chain[chain.length - 1], props)
  return h(
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: an entry between the layouts and the page is the `_error` boundary component
    chain[depth] as Component,
    { data: props.layoutData?.[depth] ?? null, boundaries: props.boundaries },
    { default: () => pageChain(chain, depth + 1, props) },
  )
}

const EMPTY_SEARCH: Readonly<Record<string, unknown>> = Object.freeze({})

const dispatch = (elements: readonly Element[], type: string): void => {
  for (const element of elements) element.dispatchEvent(new CustomEvent(type, { bubbles: true }))
}

/**
 * Hydrate the keep-alive view. Like `mountRouter` from `@nifrajs/web-vue/client`, it hydrates against
 * the state the server rendered and then follows the store.
 */
export function mountRouter(options: KeepAliveMountOptions): void {
  const { router, routes, searchSchemas, container, keepAlive: table } = options
  const matchChains = options.matchChains ?? {}
  setMountedRouter(router)

  const props = new WeakMap<RouterState, RenderProps>()
  const propsOf = (state: RouterState): RenderProps => {
    let held = props.get(state)
    if (held === undefined) {
      held = routeProps(state, searchSchemas, matchChains)
      props.set(state, held)
    }
    return held
  }
  const kept = new Map<string, Kept>()
  let rendered: readonly SlotNode[] | undefined

  // Before Vue renders the next state, while the page it hides is still laid out.
  router.beforePublish((next) => {
    for (const node of keptNodes(slotTree(next, matchChains, table, rendered))) {
      const entry = kept.get(node.key)
      if (entry === undefined || node.hidden === entry.slot.hidden.value) continue
      entry.slot.hidden.value = node.hidden
      if (node.hidden) {
        const elements = elementsOf(entry.instance.subTree)
        entry.view = rememberView(elements)
        entry.showing = false
        for (const callback of [...entry.slot.hide]) callback()
        dispatch(elements, PAGE_HIDE_EVENT)
      } else if (deactivated(entry.instance)) {
        entry.showing = true
      } else {
        // Shown again before Vue hid it: it never left the document.
        entry.view = undefined
        for (const callback of [...entry.slot.show]) callback()
        dispatch(elementsOf(entry.instance.subTree), PAGE_SHOW_EVENT)
      }
    }
  })

  let named = 0
  const slots = new Map<string, Component>()
  // One component per slot key, named for `<KeepAlive include>`.
  const slotOf = (key: string): Component => {
    let slot = slots.get(key)
    if (slot !== undefined) return slot
    slot = defineComponent({
      name: `NifraKept${++named}`,
      props: { node: { type: Object, required: true } },
      setup(slotProps) {
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Vue declares the prop as a plain Object; the level passes a SlotNode
        const first = slotProps.node as SlotNode
        const page: PageSlot = { hidden: ref(first.hidden), hide: new Set(), show: new Set() }
        provide(PAGE_KEY, page)
        // What the router hooks read, from this slot's own state. Provided here rather than by a
        // `RouteContextProvider`, whose render is a fragment the server's chain does not have.
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Vue declares the prop as a plain Object; the level passes a SlotNode
        const route = computed(() => propsOf((slotProps.node as SlotNode).state))
        provide(PROPS_KEY, route)
        provide(
          SEARCH_KEY,
          computed(() => route.value.search ?? EMPTY_SEARCH),
        )
        const instance = getCurrentInstance()
        if (first.wrapped && instance !== null) {
          const entry: Kept = { slot: page, instance, view: undefined, showing: false }
          kept.set(key, entry)
          if (typeof process !== "undefined" && process.env.NODE_ENV !== "production")
            noteKeptView(key, () => elementsOf(instance.subTree))
          onActivated(() => {
            if (!entry.showing) return
            entry.showing = false
            entry.view?.restore()
            entry.view = undefined
            for (const callback of [...page.show]) callback()
            dispatch(elementsOf(instance.subTree), PAGE_SHOW_EVENT)
          })
          onUnmounted(() => {
            if (kept.get(key) !== entry) return
            kept.delete(key)
            if (typeof process !== "undefined" && process.env.NODE_ENV !== "production")
              noteKeptView(key, undefined)
          })
        }
        return () => {
          // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Vue declares the prop as a plain Object; the level passes a SlotNode
          const node = slotProps.node as SlotNode
          const chain = routes[node.state.routeId] ?? []
          const props = route.value
          return node.children === undefined
            ? pageChain(chain, node.depth, props)
            : h(
                // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a chain entry above the page is a layout module's default export, a layout component
                chain[node.depth] as Component,
                { data: props.layoutData?.[node.depth] ?? null, boundaries: props.boundaries },
                { default: () => h(Level, { nodes: node.children }) },
              )
        }
      },
    })
    slots.set(key, slot)
    return slot
  }

  // One level of the tree: the slot it shows, inside a `<KeepAlive>` that holds the kept ones.
  const Level: Component = defineComponent({
    name: "NifraKeepAliveLevel",
    props: { nodes: { type: Array, required: true } },
    setup(levelProps) {
      return () => {
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Vue declares the prop as a plain Array; its callers pass a level of the slot tree
        const nodes = levelProps.nodes as readonly SlotNode[]
        const shown = nodes.find((node) => !node.hidden) ?? nodes.at(-1)
        if (shown === undefined) return null
        const include = nodes
          .filter((node) => node.wrapped)
          .map((node) => {
            // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: every slot component is defined with a name
            return (slotOf(node.key) as { name: string }).name
          })
        return h(
          KeepAlive,
          { include },
          { default: () => h(slotOf(shown.key), { key: shown.key, node: shown }) },
        )
      }
    },
  })

  const Root = defineComponent({
    setup() {
      const state = shallowRef(router.snapshot())
      onScopeDispose(
        router.subscribe(() => {
          state.value = router.snapshot()
        }),
      )
      const tree = computed(() => slotTree(state.value, matchChains, table, rendered))
      return () => {
        const nodes = tree.value
        rendered = nodes
        // A slot's component goes with its key; a key that comes back later gets a new one.
        const live = new Set<string>()
        const visit = (list: readonly SlotNode[]): void => {
          for (const node of list) {
            live.add(node.key)
            if (node.children !== undefined) visit(node.children)
          }
        }
        visit(nodes)
        for (const key of slots.keys()) if (!live.has(key)) slots.delete(key)
        return h(
          RouteContextProvider,
          { value: propsOf(state.value) },
          { default: () => h(Level, { nodes }) },
        )
      }
    },
  })
  const app = createSSRApp(Root)
  const warning = assuranceWarning()
  if (warning !== undefined) app.config.warnHandler = (message) => warning(message)
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the generated entry passes the element the server rendered the app into
  app.mount(container as Element)
}

function assuranceWarning(): ((message: string) => void) | undefined {
  const value = Reflect.get(globalThis, Symbol.for("nifra.hydration.assurance"))
  if (typeof value !== "object" || value === null) return undefined
  const callback: unknown = Reflect.get(value, "onWarning")
  if (typeof callback !== "function") return undefined
  return (message) => {
    Reflect.apply(callback, undefined, [message])
  }
}
