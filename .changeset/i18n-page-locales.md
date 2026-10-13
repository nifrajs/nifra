---
"@nifrajs/i18n": minor
---

`defineI18nRouting(locales, { pageLocales })` declares, once, the locales each page exists in: a pure function of the path without its locale prefix, returning locale keys, or `undefined` for every served locale. `matchSegment` then answers not-found for a page missing from the locale, `alternates` lists only the page's own locales (a page in one locale, or missing from its own, has no alternates), `localizePathname(path, locale, { fallback: "default" })` returns the default locale's page where the page is missing, and the new `localesOf(path)` names a page's locales, for a prerender's static paths too. A `pageLocales` that throws, or names a locale the registry does not declare, throws instead of serving every locale. `alternates` with an explicit `locales` of one locale now returns no links rather than a lone self-reference.
