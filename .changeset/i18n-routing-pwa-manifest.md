---
"@nifrajs/i18n": minor
"@nifrajs/web": minor
---

feat(i18n): one locale registry and locale-prefixed routing; feat(web): PWA manifest builder

`defineLocales()` declares each locale once - URL segment, BCP-47 tag for `Intl`, `hreflang` value,
writing direction and native name, each defaulted from the segment - and marks unfinished
translations `draft`. It validates tags, segments and `hreflang` uniqueness at definition and gives
`served`, `get()`, a catalog fallback `chain()` (`fr-CA` → `fr` → default) and `documentMeta()` for a
route's `<html lang>`/`<html dir>`. `localeDirection()` derives the direction from an explicit
script, a right-to-left language, or the runtime's likely script.

`@nifrajs/i18n/routing` adds `defineI18nRouting(locales)` - the URL half of i18n next to
`negotiateLocale`'s detection half. Pure and dependency-free: prefix, strip and read locale prefixes
(served locales only, case-insensitive, so `/frank` never reads as French and a draft's prefix is an
ordinary segment); `alternates(path, { origin?, locales? })` returns the page's canonical URL and its
`hreflang` links - absolute or root-relative, limited to the locales the page exists in, listed in
registry order so every page of a cluster agrees, with `x-default` when the default is listed; and
`matchSegment()` checks a `[lang]` route segment for a `_middleware.ts` guard, answering not-found for
an unknown or draft value and a redirect for the default's prefix or a wrong case. No path it builds
can start with `//` or `/\`. No regex runs on request input.

`@nifrajs/web/pwa-manifest` adds `pwaManifest()` - the declarative PWA half next to the
service-worker generator. Pure builder for `manifest.json` bytes (names, scope defaulted
from `start_url`, icons/screenshots/shortcuts, colors) with fail-loud validation of spec
shapes, plus `serializeManifest()` and the `<link rel="manifest">` tag helper.
