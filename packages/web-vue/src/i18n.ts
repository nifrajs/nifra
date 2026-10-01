/**
 * `@nifrajs/web-vue/i18n` - Vue bindings for `@nifrajs/i18n`. `<I18nProvider locale messages>` builds a
 * `Formatter` (a `computed`, so switching locale rebuilds it) and `provide`s it; `useT()` `inject`s it.
 * Both `locale` + `messages` are serializable, so a loader returns them, the page renders with the
 * negotiated catalog on the server, and the client rebuilds the same formatter on hydrate (no
 * mismatch). Imports only `vue` + `@nifrajs/i18n`; no template.
 */
import {
  createFormatter,
  type Formatter,
  type FormatterOptions,
  type MessageKey,
  type RegisteredMessages,
  type Translation,
} from "@nifrajs/i18n"
import { type RichChunks, type RichRenderer, renderRich } from "@nifrajs/i18n/rich"
import {
  type ComputedRef,
  computed,
  defineComponent,
  Fragment,
  h,
  type InjectionKey,
  inject,
  type PropType,
  provide,
  type VNodeChild,
} from "vue"

const I18N_KEY: InjectionKey<ComputedRef<Formatter>> = Symbol("nifra-i18n")

/** Provide a {@link Formatter} (built from `locale` + `messages`, with the optional `fallback`,
 * `onMissing`, `timeZone` and `numberingSystem` of `createFormatter`) to the subtree. Recomputes
 * when any of them changes, so a locale switch re-renders consumers. Renders its default slot. */
export const I18nProvider = defineComponent({
  name: "I18nProvider",
  props: {
    locale: { type: String, required: true },
    messages: { type: Object as PropType<Translation>, required: true },
    fallback: { type: Array as PropType<NonNullable<FormatterOptions["fallback"]>> },
    onMissing: { type: Function as PropType<NonNullable<FormatterOptions["onMissing"]>> },
    timeZone: { type: String },
    numberingSystem: { type: String },
  },
  setup(props, { slots }) {
    provide(
      I18N_KEY,
      computed(() =>
        createFormatter(props.locale, props.messages, {
          fallback: props.fallback,
          onMissing: props.onMissing,
          timeZone: props.timeZone,
          numberingSystem: props.numberingSystem,
        }),
      ),
    )
    return () => slots.default?.()
  },
})

/** Read the current {@link Formatter} (`{ locale, t, get, n, d }`). Throws if no `<I18nProvider>` is above. */
export function useT(): Formatter {
  const formatter = inject(I18N_KEY)
  if (formatter === undefined) {
    throw new Error("[nifra/web-vue] useT() must be used within an <I18nProvider>")
  }
  return formatter.value
}

/** Tag handlers for {@link rich}, by tag name: each receives its tag's content as one node. */
export type RichTags = Readonly<Record<string, (content: VNodeChild) => VNodeChild>>

const join = (chunks: RichChunks<VNodeChild>): VNodeChild =>
  chunks.length === 0 ? null : chunks.length === 1 ? chunks[0] : h(Fragment, null, [...chunks])
const VUE_RICH: RichRenderer<VNodeChild> = { join, lineBreak: () => h("br") }

/**
 * The message at `key` with its tags rendered by `tags`, as Vue vnodes - no HTML, no `v-html`.
 * `"Read the <link>terms</link>"` with `{ link: (content) => h("a", { href: "/terms" }, [content]) }`
 * renders the link around "terms"; a tag with no handler renders its content as text, `<br/>` is a
 * `<br>`, and interpolated values are always text. Call it in a render function (or a template
 * through a component) so a locale change re-renders it. See `@nifrajs/i18n/rich`.
 */
export function rich<M extends object = RegisteredMessages>(
  formatter: Formatter<M>,
  key: MessageKey<M>,
  tags?: RichTags,
  vars?: Readonly<Record<string, unknown>>,
): VNodeChild {
  return renderRich(VUE_RICH, formatter, key, tags, vars)
}
