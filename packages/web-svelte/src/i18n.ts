/**
 * `@nifrajs/web-svelte/i18n` - Svelte bindings for `@nifrajs/i18n`: the `<I18nProvider>` component (re-exported
 * from `I18nProvider.svelte`) plus `useT()`, which reads the provided `Formatter` from Svelte context.
 * Call `useT()` during a component's initialization (like any `getContext`). `<Rich>` renders a
 * message's tags with snippets; `rich()` returns the same message as a parts array. In an app that
 * registers its locale routing (`i18n` in `backend/framework.ts`), `<I18nProvider>`'s `locale`
 * defaults to the page's and `useLocale()` names it.
 */
import type { Formatter } from "@nifrajs/i18n"
import type { RenderProps } from "@nifrajs/web"
import { localeOfProps } from "@nifrajs/web/client"
import { getContext } from "svelte"

export { type RichChunks, type RichTags, rich } from "@nifrajs/i18n/rich"
export { default as I18nProvider, type I18nProviderProps } from "./I18nProvider.svelte"
export { default as Rich, type RichProps } from "./Rich.svelte"

// Must match the string key `I18nProvider.svelte` passes to `setContext` (a string avoids a
// `.svelte` → `.ts` import that wouldn't resolve once the .svelte is copied to dist).
const I18N_KEY = "@nifrajs/web-svelte:i18n"
// The key `Chain.svelte` provides the render's props under.
const PROPS_KEY = "@nifrajs/web-svelte:props"

/** Read the current {@link Formatter} (`{ locale, t, get, n, d }`). Throws if no `<I18nProvider>` is above.
 * nifra switches locale by re-navigating, which re-runs the consuming component with the new catalog. */
export function useT(): Formatter {
  const get = getContext<(() => Formatter) | undefined>(I18N_KEY)
  if (get === undefined) {
    throw new Error("[nifra/web-svelte] useT() must be used within an <I18nProvider>")
  }
  return get()
}

/**
 * The page's locale key (`ur`, the URL segment) as an accessor, in an app that registers its locale
 * routing (`i18n` in `backend/framework.ts`): from the request on the server, from the URL after each
 * navigation. Without one, the nearest `<I18nProvider>`'s locale; with neither, calling it throws.
 * Call `useLocale()` during a component's initialization.
 */
export function useLocale(): () => string {
  const props = getContext<(() => RenderProps) | undefined>(PROPS_KEY)
  const formatter = getContext<(() => Formatter) | undefined>(I18N_KEY)
  return () => {
    const locale = localeOfProps(props?.())?.key ?? formatter?.().locale
    if (locale === undefined) {
      throw new Error(
        "[nifra/web-svelte] useLocale() needs an app that registers its locale routing (export `i18n` from backend/framework.ts), or an <I18nProvider> above it",
      )
    }
    return locale
  }
}
