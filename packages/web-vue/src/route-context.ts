import type { RenderProps } from "@nifrajs/web"
import { computed, defineComponent, type InjectionKey, provide, type Ref } from "vue"

// `Symbol.for`, not `Symbol()`: in dev this module is evaluated twice in one process (the app's
// server code under Bun provides; route modules through Vite's SSR runner inject), and `provide`/
// `inject` match by key identity - a per-evaluation symbol makes `useSearch` SSR-render `{}` in dev.
// biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: InjectionKey only brands a symbol's type, and every provide of this registry key passes a Ref of the search record.
export const SEARCH_KEY: InjectionKey<Ref<Record<string, unknown>>> = Symbol.for(
  "nifra.web-vue.search",
) as InjectionKey<Ref<Record<string, unknown>>>

// The props `compose` rendered the chain with - what `useMatches` and the i18n locale read.
// biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: InjectionKey only brands a symbol's type, and every provide of this registry key passes a Ref of RenderProps.
export const PROPS_KEY: InjectionKey<Readonly<Ref<RenderProps>>> = Symbol.for(
  "nifra.web-vue.render-props",
) as InjectionKey<Readonly<Ref<RenderProps>>>

// Frozen empty search so a render with no search context has a stable provider value.
const EMPTY_SEARCH: Readonly<Record<string, unknown>> = Object.freeze({})

/**
 * The one component `compose` wraps every page in: it provides both {@link SEARCH_KEY} (from
 * `value.search`) and {@link PROPS_KEY}, as `computed` views of its `value` prop so they follow each
 * navigation's props. One instance, not a `SearchProvider` around a `RenderPropsProvider`: a Vue
 * component instance per request is a large share of a small page's SSR cost.
 */
export const RouteContextProvider = defineComponent({
  name: "NifraRouteContext",
  props: { value: { type: Object, required: true } },
  setup(props, { slots }) {
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Vue declares the prop as a plain Object; its one caller, compose, passes the RenderProps it renders with.
    const renderProps = computed(() => props.value as RenderProps)
    provide(
      SEARCH_KEY,
      computed(() => renderProps.value.search ?? EMPTY_SEARCH),
    )
    provide(PROPS_KEY, renderProps)
    return () => slots.default?.()
  },
})
