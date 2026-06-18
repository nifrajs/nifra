/**
 * `@nifrajs/web-vue/i18n` — Vue bindings for `@nifrajs/i18n`. `<I18nProvider locale messages>` builds a
 * `Formatter` (a `computed`, so switching locale rebuilds it) and `provide`s it; `useT()` `inject`s it.
 * Both `locale` + `messages` are serializable, so a loader returns them, the page renders with the
 * negotiated catalog on the server, and the client rebuilds the same formatter on hydrate (no
 * mismatch). Imports only `vue` + `@nifrajs/i18n`; no template.
 */
import { createFormatter, type Formatter, type Messages } from "@nifrajs/i18n"
import {
  type ComputedRef,
  computed,
  defineComponent,
  type InjectionKey,
  inject,
  type PropType,
  provide,
} from "vue"

const I18N_KEY: InjectionKey<ComputedRef<Formatter>> = Symbol("nifra-i18n")

/** Provide a {@link Formatter} (built from `locale` + `messages`) to the subtree. Recomputes when
 * `locale`/`messages` change, so a locale switch re-renders consumers. Renders its default slot. */
export const I18nProvider = defineComponent({
  name: "I18nProvider",
  props: {
    locale: { type: String, required: true },
    messages: { type: Object as PropType<Messages>, required: true },
  },
  setup(props, { slots }) {
    provide(
      I18N_KEY,
      computed(() => createFormatter(props.locale, props.messages)),
    )
    return () => slots.default?.()
  },
})

/** Read the current {@link Formatter} (`{ locale, t, n, d }`). Throws if no `<I18nProvider>` is above. */
export function useT(): Formatter {
  const formatter = inject(I18N_KEY)
  if (formatter === undefined) {
    throw new Error("[nifra/web-vue] useT() must be used within an <I18nProvider>")
  }
  return formatter.value
}
