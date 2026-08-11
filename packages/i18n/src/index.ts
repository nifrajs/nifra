/**
 * `@nifrajs/i18n` - framework-agnostic internationalization for nifra. Locale negotiation +
 * a tiny ICU message formatter on the platform `Intl`. Dependency-free; bring your own JSON catalogs.
 * Per-adapter `<I18nProvider>` + `useT()` bindings live in the adapter packages; the server plugin
 * (`localeDetector()`) lives at `@nifrajs/i18n/detector` and needs `@nifrajs/core`.
 */
export { createFormatter, type Formatter, type Messages } from "./format.ts"
export {
  type Locale,
  type LocaleParts,
  type LocaleSource,
  type NegotiateOptions,
  negotiateLocale,
  type ResolvedLocale,
  resolveLocale,
} from "./negotiate.ts"
