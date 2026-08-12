# @nifrajs/i18n

## 2.12.0

### Minor Changes

- ceda72d: Locale detection grows an explicit-ask tier and a server plugin.

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

### Patch Changes

- b5f47c0: `__Secure-` and `__Host-` cookie name prefixes (RFC 6265bis) are now enforced, matched
  case-insensitively the way browsers match them. `serializeCookie` throws on a `Set-Cookie` that
  violates its name's prefix contract - `__Secure-` requires `Secure`; `__Host-` requires `Secure`
  and `Path=/` and forbids `Domain` - instead of emitting a cookie the user agent silently discards.
  `c.set.cookie`'s secure defaults already satisfy both contracts, so prefixed names work with zero
  configuration, and `c.set.deleteCookie` applies `Secure` to the deletion write for a prefixed name
  so the browser accepts the deletion (the failure mode behind Hono's CVE-2026-39410 class: a
  non-conforming deletion leaves the cookie alive after logout). The new `cookieNamePrefix(name)`
  export classifies a name as `"secure"`, `"host"`, or unprefixed. `@nifrajs/i18n`'s `localeDetector`
  applies `Secure` automatically when its persist cookie name carries a prefix.

## 2.11.0

## 2.10.0

## 2.9.1

## 2.9.0

## 2.8.2

## 2.8.1

## 2.8.0

## 2.7.1

## 2.7.0

## 2.6.1

## 2.6.0

## 2.5.0

## 2.4.0

## 2.3.0

## 2.2.0

## 2.1.0

## 2.0.0

## 1.13.0

## 1.12.0

## 1.11.0

## 1.10.0

## 1.9.1

## 1.9.0

## 1.8.0

## 1.7.0

## 1.6.0

## 1.5.0

## 1.4.0

## 1.3.1

## 1.3.0

## 1.2.2

## 1.2.1

## 1.2.0

## 1.1.0

## 1.0.0

## 1.0.0-beta.4

## 1.0.0-beta.3

## 0.1.0-beta.2
