import type { Messages } from "@nifrajs/i18n"
import type { Component, Snippet } from "svelte"

/** Hand-written types for `I18nProvider.svelte` (consumers resolve these via the `./i18n` re-export). */
export interface I18nProviderProps {
  /** The active locale (e.g. `"en"`, `"fr-CA"`). */
  locale: string
  /** The ICU message catalog for `locale`. */
  messages: Messages
  /** The subtree that reads the formatter via `useT()`. */
  children?: Snippet
}

declare const I18nProvider: Component<I18nProviderProps>
export default I18nProvider
