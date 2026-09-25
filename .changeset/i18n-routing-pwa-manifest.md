---
"@nifrajs/i18n": minor
"@nifrajs/web": minor
---

feat(i18n): locale-prefixed routing helper; feat(web): PWA manifest builder

`@nifrajs/i18n/routing` adds `defineI18nRouting()` - the URL half of i18n next to
`negotiateLocale`'s detection half. Pure and dependency-free: prefix pathnames with a
locale, strip/read locale prefixes (full-tag, case-insensitive matching, so `/frank`
never reads as French), and emit absolute `hreflang` alternates plus `x-default` for
SEO. Options are validated once at definition; no regex runs on request input.

`@nifrajs/web/pwa-manifest` adds `pwaManifest()` - the declarative PWA half next to the
service-worker generator. Pure builder for `manifest.json` bytes (names, scope defaulted
from `start_url`, icons/screenshots/shortcuts, colors) with fail-loud validation of spec
shapes, plus `serializeManifest()` and the `<link rel="manifest">` tag helper.
