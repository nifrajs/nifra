import {
  type App,
  type AppContext,
  createSSRApp,
  type FunctionalComponent,
  isVNode,
  type VNodeChild,
} from "vue"

/** Renders a hole's output that cannot be the app's root component itself. */
const HoleRoot: FunctionalComponent<{ node: VNodeChild }> = (props) => props.node
HoleRoot.props = ["node"]

// ShapeFlags.STATEFUL_COMPONENT | ShapeFlags.FUNCTIONAL_COMPONENT
const COMPONENT = 6
// Hole names are static, so this is only a backstop against an unbounded set of prefixes.
const MAX_PREFIXES = 256

// Vue keeps its props, emits and options normalization per app, so a fresh app per render redid all
// of it; one app per id prefix keeps it, and its config carries the prefix.
const bases = new Map<string, App>()
const baseFor = (idPrefix: string | undefined): App => {
  const key = idPrefix ?? ""
  let base = bases.get(key)
  if (base === undefined) {
    if (bases.size >= MAX_PREFIXES) bases.clear()
    base = createSSRApp(HoleRoot)
    if (idPrefix !== undefined) base.config.idPrefix = idPrefix
    bases.set(key, base)
  }
  return base
}

/**
 * An app that renders `node` once, for Vue's `renderToString`, which reads only `_component`,
 * `_props`, `_context` and `provide` of it. Each render owns its `provides`: concurrent renders under
 * one prefix each provide their own SSR context, which components read after an await. A component
 * VNode without slots or directives is the root itself, sparing a wrapper component instance.
 */
export function holeApp(node: VNodeChild, idPrefix: string | undefined): App {
  const base = baseFor(idPrefix)
  const context: AppContext = Object.create(base._context)
  context.provides = Object.create(base._context.provides)
  const asRoot =
    isVNode(node) &&
    (node.shapeFlag & COMPONENT) !== 0 &&
    node.children === null &&
    node.dirs === null
  const app: App = Object.create(base, {
    _component: { value: asRoot ? node.type : HoleRoot },
    _props: { value: asRoot ? node.props : { node } },
    _context: { value: context },
    provide: {
      value: (key: PropertyKey, value: unknown): App => {
        Reflect.set(context.provides, key, value)
        return app
      },
    },
  })
  return app
}
