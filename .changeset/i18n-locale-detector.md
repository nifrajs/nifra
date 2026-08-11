---
"@nifrajs/i18n": minor
---

Locale detection grows an explicit-ask tier and a server plugin.

- `negotiateLocale()` accepts `queryParam`: a `?lang=fr` link now wins over the cookie and
  `Accept-Language`. The answer is still always drawn from the `locales` allow-list - request input
  is matched, never echoed - and parsing stays split-based and linear.
- New `resolveLocale()` returns `{ locale, source, cookie }`, reporting which source won and what
  the locale cookie currently resolves to. Both accept a `Request` or a structural
  `{ url?, header, query? }` slice.
- New `localeDetector()` plugin at `@nifrajs/i18n/detector` (needs the new optional
  `@nifrajs/core` peer; the package root stays dependency-free): derives `c.locale` /
  `c.localeSource`, emits `Content-Language`, and with `persist: true` writes the locale cookie
  only when an explicit `?lang=` choice differs from it - header-derived guesses are never pinned
  and plain responses never grow a `Set-Cookie`, so they stay cacheable.
