/**
 * `@nifrajs/web-svelte/i18n` — Svelte bindings for `@nifrajs/i18n`: the `<I18nProvider>` component (re-exported
 * from `I18nProvider.svelte`) plus `useT()`, which reads the provided `Formatter` from Svelte context.
 * Call `useT()` during a component's initialization (like any `getContext`).
 */
import type { Formatter } from "@nifrajs/i18n"
import { getContext } from "svelte"

export { default as I18nProvider, type I18nProviderProps } from "./I18nProvider.svelte"

// Must match the string key `I18nProvider.svelte` passes to `setContext` (a string avoids a
// `.svelte` → `.ts` import that wouldn't resolve once the .svelte is copied to dist).
const I18N_KEY = "@nifrajs/web-svelte:i18n"

/** Read the current {@link Formatter} (`{ locale, t, n, d }`). Throws if no `<I18nProvider>` is above.
 * nifra switches locale by re-navigating, which re-runs the consuming component with the new catalog. */
export function useT(): Formatter {
  const get = getContext<(() => Formatter) | undefined>(I18N_KEY)
  if (get === undefined) {
    throw new Error("[nifra/web-svelte] useT() must be used within an <I18nProvider>")
  }
  return get()
}
