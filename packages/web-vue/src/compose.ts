import type { RenderProps } from "@nifrajs/web"
import { type Component, camelize, h, type VNode } from "vue"
import { RouteContextProvider } from "./route-context.ts"

// What Vue reads off a component, an options object or a function, to resolve the props it declares.
interface Fields {
  readonly props?: unknown
  readonly extends?: unknown
  readonly mixins?: unknown
  readonly __vccOpts?: unknown
  readonly __asyncLoader?: unknown
}
type Options = Fields | (Fields & ((...args: never[]) => unknown))
const isOptions = (value: unknown): value is Options =>
  (typeof value === "object" && value !== null) || typeof value === "function"

// The props each component declares, camelized as Vue matches them: its own and those of its `extends`
// and `mixins`. `null` for one Vue hands every prop to: a functional component that declares none, or
// an async wrapper, which passes them to the component it loads. Held with the options they were read
// from, since Vue's hot reload rewrites a component's options in place.
interface Held {
  readonly props: unknown
  readonly extends: unknown
  readonly mixins: unknown
  readonly vcc: unknown
  readonly names: ReadonlySet<string> | null
}
const declared = new WeakMap<object, Held>()

const addDeclared = (options: unknown, names: Set<string>): void => {
  if (!isOptions(options)) return
  const { props, mixins } = options
  if (Array.isArray(props)) for (const name of props) names.add(camelize(name))
  else if (isOptions(props)) for (const name in props) names.add(camelize(name))
  addDeclared(options.extends, names)
  if (Array.isArray(mixins)) for (const mixin of mixins) addDeclared(mixin, names)
}

const declaredBy = (component: Options): ReadonlySet<string> | null => {
  const options = isOptions(component.__vccOpts) ? component.__vccOpts : component
  if (typeof options === "function" ? !options.props : options.__asyncLoader) return null
  const names = new Set<string>()
  addDeclared(options, names)
  return names
}

/**
 * `props` less those `component` does not declare. Vue hands an undeclared prop to the component as an
 * attribute and puts it on its root element: the client renders an object as "[object Object]" and
 * the server renders it not at all, and a fragment root warns on every render instead.
 */
export function ownProps<P extends object>(component: unknown, props: P): Partial<P> {
  if (!isOptions(component)) return props
  let held = declared.get(component)
  if (
    held === undefined ||
    held.props !== component.props ||
    held.extends !== component.extends ||
    held.mixins !== component.mixins ||
    held.vcc !== component.__vccOpts
  ) {
    held = {
      props: component.props,
      extends: component.extends,
      mixins: component.mixins,
      vcc: component.__vccOpts,
      names: declaredBy(component),
    }
    declared.set(component, held)
  }
  const names = held.names
  if (names === null) return props
  const own: Partial<P> = {}
  for (const key in props) if (names.has(key)) own[key] = props[key]
  return own
}

/**
 * Fold a layout chain (outermost layout → page) into a single Vue VNode: the page (innermost)
 * receives `props` (the loader data); each layout wraps the child via its default slot. The whole tree
 * is wrapped in a {@link RouteContextProvider} carrying the props, including the validated `search`
 * (threaded through `RenderProps` identically on SSR + client), so `useSearch` and `useMatches` read
 * the same values on both sides - no hydration mismatch. Shared by the server adapter
 * (renderToWebStream) and the client (hydrate / mountRouter) - the Vue analogue of the React
 * adapter's `compose`.
 */
export function compose(chain: readonly unknown[], props: RenderProps): VNode {
  const last = chain.length - 1
  let node: VNode = pageNode(chain[last], props)
  for (let i = last - 1; i >= 0; i--) {
    const child = node
    // Layouts render their child via the default slot (`<slot />` / `{@render children}`).
    // Each layout receives its own loader data at its own index. Layouts are the chain's leading
    // prefix, so `layoutData[i]` belongs to `chain[i]`; anything past that end (a client-only `_error`
    // boundary marker, the page) reads `undefined` and is unaffected.
    node = h(
      chain[i] as Component,
      ownProps(chain[i], {
        data: props.layoutData?.[i] ?? null,
        ...(props.boundaries !== undefined ? { boundaries: props.boundaries } : {}),
      }),
      { default: () => child },
    )
  }
  const inner = node
  return h(RouteContextProvider, { value: props }, { default: () => inner })
}

/** The page's vnode: the route props it declares. The provider carries every one to the hooks. */
export function pageNode(page: unknown, props: RenderProps): VNode {
  return h(page as Component, ownProps(page, props))
}
