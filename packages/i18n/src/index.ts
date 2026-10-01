/**
 * `@nifrajs/i18n` - framework-agnostic internationalization for nifra. One locale registry
 * (`defineLocales`), locale negotiation and a tiny ICU message formatter on the platform `Intl`.
 * Dependency-free; bring your own catalogs. Locale-prefixed URLs live at `@nifrajs/i18n/routing`.
 * Per-adapter `<I18nProvider>` + `useT()` bindings live in the adapter packages; the server plugin
 * (`localeDetector()`) lives at `@nifrajs/i18n/detector` and needs `@nifrajs/core`.
 */
export { createFormatter, type Formatter, type Messages } from "./format.ts"
export {
  defineLocales,
  type LocaleInfo,
  type LocaleSpec,
  type Locales,
  type LocalesConfig,
  localeDirection,
} from "./locales.ts"
export {
  type Locale,
  type LocaleParts,
  type LocaleSource,
  type NegotiateOptions,
  negotiateLocale,
  type ResolvedLocale,
  resolveLocale,
} from "./negotiate.ts"
