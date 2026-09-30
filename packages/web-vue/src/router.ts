import type { InferOutput, StandardSchemaV1 } from "@nifrajs/core/server"
// `import type` + a local re-export, NOT `export type { … } from "@nifrajs/web"`: that form leaves a
// bare `import "@nifrajs/web"` in the output, which pulls the server graph into the browser under
// Vite's dev server. Sourced from the ROOT so the generated `RouteSearch` augmentation applies.
import type {
  Blocker,
  BlockerFunction,
  BlockerState,
  NavigateFunction,
  NavigateOptions,
  NavigateTargetInput,
  RenderProps,
  UIMatch,
} from "@nifrajs/web"
// `/client`, not the root - these are DOM values, and the root's graph carries the
// server, which Vite's dev server evaluates rather than tree-shakes.
import {
  getBrowserNavigate,
  IDLE_BLOCKER,
  registerBlocker,
  resolveNavigate,
} from "@nifrajs/web/client"
// Its own subpath, so an app that never calls `useMatches` never bundles it.
import { chainMatches } from "@nifrajs/web/internal/matches-runtime"
/**
 * `@nifrajs/web-vue/router` - Vue routing bindings over the agnostic `@nifrajs/web` history layer:
 * `useNavigate` (programmatic navigation), `useBlocker` (the unsaved-changes guard), and `useSearch`
 * (the route's typed, validated search, as a reactive ref). Navigation goes through `@nifrajs/web`'s
 * DOM-free bridges (`getBrowserNavigate` / `registerBlocker`, populated by `installHistory`); `useSearch`
 * reads the value `compose` provides on SSR + client mount alike. Imports only `vue`, so it is SSR-safe.
 */
import {
  computed,
  defineComponent,
  type InjectionKey,
  inject,
  onScopeDispose,
  provide,
  type Ref,
  type ShallowRef,
  shallowRef,
} from "vue"

export type { Blocker, BlockerFunction, BlockerState, NavigateFunction, UIMatch }

// Frozen empty search + a stable fallback ref for a `useSearch` used outside a nifra route tree.
const EMPTY_SEARCH: Readonly<Record<string, unknown>> = Object.freeze({})
const EMPTY_SEARCH_REF: Ref<Record<string, unknown>> = shallowRef(EMPTY_SEARCH)

// `Symbol.for`, not `Symbol()`: in dev this module is evaluated twice in one process (the app's
// server code under Bun provides; route modules through Vite's SSR runner inject), and `provide`/
// `inject` match by key identity - a per-evaluation symbol makes `useSearch` SSR-render `{}` in dev.
const SEARCH_KEY: InjectionKey<Ref<Record<string, unknown>>> = Symbol.for(
  "nifra.web-vue.search",
) as InjectionKey<Ref<Record<string, unknown>>>

/**
 * The provider `compose` wraps the layout tree in. It `provide`s a `computed` view of its `value` prop,
 * so as the mount re-renders with each navigation's search the injected ref updates reactively (setup
 * runs once, but the computed keeps tracking the prop). Renders its default slot (the folded chain).
 */
export const SearchProvider = defineComponent({
  name: "NifraSearchProvider",
  props: { value: { type: Object, required: true } },
  setup(props, { slots }) {
    provide(
      SEARCH_KEY,
      computed(() => (props.value ?? EMPTY_SEARCH) as Record<string, unknown>),
    )
    return () => slots.default?.()
  },
})

// The props `compose` rendered the chain with - what `useMatches` reads. `Symbol.for` for the same
// reason as the search key.
const PROPS_KEY: InjectionKey<Readonly<Ref<RenderProps>>> = Symbol.for(
  "nifra.web-vue.render-props",
) as InjectionKey<Readonly<Ref<RenderProps>>>

/** The provider `compose` wraps the chain in for {@link useMatches}: a `computed` view of its `value`
 * prop, so the injected ref follows each navigation's props. Renders its default slot. */
export const RenderPropsProvider = defineComponent({
  name: "NifraRenderPropsProvider",
  props: { value: { type: Object, required: true } },
  setup(props, { slots }) {
    provide(
      PROPS_KEY,
      computed(() => props.value as RenderProps),
    )
    return () => slots.default?.()
  },
})

const NO_MATCHES: readonly UIMatch[] = Object.freeze([])

/**
 * The rendered chain - each layout, then the page - with the URL prefix, params and loader data each
 * one owns, plus its `handle` export, as a reactive ref. The same list on the server render and the
 * client mount, so a layout can render breadcrumbs from its children's `handle`s without a hydration
 * mismatch.
 *
 * ```vue
 * // page: export const handle = { crumb: "Settings" } (a plain <script> block)
 * const matches = useMatches()
 * const crumbs = computed(() => matches.value.flatMap((m) => (m.handle as { crumb?: string } | undefined)?.crumb ?? []))
 * ```
 */
export function useMatches(): Readonly<Ref<readonly UIMatch[]>> {
  const props = inject(PROPS_KEY, undefined)
  return computed(() => (props === undefined ? NO_MATCHES : chainMatches(props.value)))
}

/**
 * The route's typed, validated search params as a reactive ref - the SAME value the loader received as
 * `ctx.search`. SSR-correct: `compose` provides it from the URL server-side and from the identical
 * client-mount derivation, so a value rendered from it doesn't flash on hydration. Read `search.value`
 * (reactive across navigation). Pass the route's `searchSchema` as the type argument for its output type.
 *
 * ```vue
 * const search = useSearch<typeof searchSchema>() // Ref<{ page: number }>
 * // template: {{ search.page }}
 * ```
 */
export function useSearch<Schema extends StandardSchemaV1 | undefined = undefined>(): Readonly<
  Ref<Schema extends StandardSchemaV1 ? InferOutput<Schema> : Record<string, unknown>>
> {
  return inject(SEARCH_KEY, EMPTY_SEARCH_REF) as Readonly<
    Ref<Schema extends StandardSchemaV1 ? InferOutput<Schema> : Record<string, unknown>>
  >
}

/** Get the {@link NavigateFunction} (a string path, a history delta, or a typed `{ to, search }` object).
 * Resolves the browser navigate at call time, so it works as soon as `installHistory` has run and no-ops
 * before then / on the server. */
export function useNavigate(): NavigateFunction {
  return ((to: string | number | NavigateTargetInput, options?: NavigateOptions) => {
    const navigate = getBrowserNavigate()
    if (navigate === undefined) return
    const resolved = resolveNavigate(to, options)
    navigate(resolved.to, resolved.options)
  }) as NavigateFunction
}

/**
 * Guard navigation away from a page with unsaved work, confirming with your OWN async UI. Mirrors
 * react-router's `useBlocker`: pass a boolean or a `({ currentLocation, nextLocation }) => boolean`
 * predicate, and get back a reactive {@link Blocker} ref. When a navigation (an anchor click,
 * `useNavigate`, or a browser back/forward) is intercepted, `blocker.value.state` becomes `"blocked"`
 * and `proceed`/`reset` go live - render a dialog and call `proceed()` to continue or `reset()` to stay.
 * It also arms the browser's native "Leave site?" prompt on tab close / reload. Idle on the server and
 * before hydration.
 *
 * `setup` runs once, so to track a CHANGING flag pass a function - `useBlocker(() => form.isDirty)` -
 * not a bare `ref` (which would be truthy and always block). A constant boolean is fine as-is.
 */
export function useBlocker(shouldBlock: boolean | BlockerFunction): Readonly<ShallowRef<Blocker>> {
  const blocker = shallowRef<Blocker>(IDLE_BLOCKER)
  const unregister = registerBlocker(
    (args) => (typeof shouldBlock === "function" ? shouldBlock(args) : shouldBlock),
    (next) => {
      blocker.value = next
    },
  )
  onScopeDispose(unregister)
  return blocker
}
