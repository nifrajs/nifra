import type { FormatterOptions, Translation } from "@nifrajs/i18n"
import type { Component, Snippet } from "svelte"

/** Hand-written types for `I18nProvider.svelte` (consumers resolve these via the `./i18n` re-export). */
export interface I18nProviderProps extends FormatterOptions {
  /** The active locale (e.g. `"en"`, `"fr-CA"`). */
  locale: string
  /** The catalog for `locale`, checked against the registered catalog type when one is declared. */
  messages: Translation
  /** The subtree that reads the formatter via `useT()`. */
  children?: Snippet
}

declare const I18nProvider: Component<I18nProviderProps>
export default I18nProvider
