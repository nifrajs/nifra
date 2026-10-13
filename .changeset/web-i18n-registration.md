---
"@nifrajs/web": minor
"@nifrajs/cli": minor
"@nifrajs/web-react": minor
"@nifrajs/web-preact": minor
"@nifrajs/web-solid": minor
"@nifrajs/web-svelte": minor
"@nifrajs/web-vue": minor
---

An app registers its locale routing once: `export const i18n = urls` (the router `defineI18nRouting()` returns) from `backend/framework.ts`, which `nifra dev`, `nifra build` and the generated server entry pass to `createWebApp({ i18n })`. Every document then takes `<html lang dir>` from the registry's `documentMeta(localeOf(path))` unless the route's meta sets `lang`, on a hard load and after each client navigation, and carries `Content-Language`. Each adapter's new `useLocale()` returns the page's locale key, and `<I18nProvider>` formats in the page's locale when no `locale` is passed, with no loader handing either over. A route under a `[lang]` or `[[lang]]` directory runs `matchSegment()` before any middleware: an unserved locale, or a page missing from it, is a 404 through the app's `_404`, and a non-canonical prefix such as `/en/x` with an unprefixed default is a 308 to `/x`.
