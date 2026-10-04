# @nifrajs/i18n

## 4.0.0

### Minor Changes

- 772249a: feat(i18n): catalog checks - `checkCatalogs()` and `nifra i18n check`

  `checkCatalogs({ locales, catalogs, ignore })` from the new `@nifrajs/i18n/check` entry checks every
  catalog in a locale registry the way `t()` reads it: coverage per locale (counting messages inherited
  through `chain()`), missing keys and keys the default catalog does not have, ICU syntax,
  placeholder and rich-tag parity with the default message, a missing `other` case, plural categories
  the locale's grammar uses that a message never states, script purity (letters outside
  `Intl.Locale(tag).maximize().script`, and, as a warning, words mixing Latin with it), and messages identical to the
  default in another language. It returns findings with a severity (`error`, `warning`, `info`) and a
  per-locale coverage table; `ignore` skips keys per check.

  `nifra i18n check [entry]` imports the module exporting `locales` and `catalogs` (the first
  `i18n.ts` in the project root, `lib/`, `src/`, `src/lib/` or `app/` by default; catalogs may be
  lazy loaders such as `() => import("./fr.json")`) and prints the report. It exits 1 on an error, and
  with `--strict` on a warning; `--json` prints the result.

- f70f99b: feat(i18n): selectordinal, fallback catalogs, typed nested catalogs and the locale cookie

  The formatter supports `selectordinal` (`{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}`).
  Inside a `plural` or `selectordinal` case, `#` is now the number in the locale's own format
  (`1,000 items`, `1.000 Artikel`) instead of its plain digits - the output changes for counts of 1,000
  and more and for fractions.

  `createFormatter(locale, messages, options)` takes `fallback` catalogs, tried in order for a key the
  catalog lacks (`locales.chain()` gives the order); `onMissing(key, locale)`, called once per key when
  no catalog has it; and `timeZone` and `numberingSystem` defaults for `d()`, `n()` and `#`. An invalid
  locale, time zone or numbering system throws at creation. Formatters are cached per catalog and
  options, with bounded caches, so per-request values cannot grow memory.

  Catalogs may nest: values are messages, lists or blocks, read with dotted keys (`t("home.title")`); a
  flat key that contains a dot is found first, so flat catalogs work unchanged. `get(key)` returns a list
  or block whole. Lookups read own properties only, and an argument named like an `Object.prototype`
  member renders empty unless passed. Declaring `interface Register { messages: typeof en }` on
  `@nifrajs/i18n` types every `t()` and `get()` key, and other locales' catalogs (`Translation`,
  `PartialMessages`) against that shape.

  `localeCookie(name, locale, { maxAge })` returns the `document.cookie` string for a language switcher,
  byte-identical to the `Set-Cookie` `localeDetector({ persist: true })` writes.

  Every adapter's `<I18nProvider>` takes `fallback`, `onMissing`, `timeZone` and `numberingSystem`, and
  its `messages` prop is checked against the registered catalog type.

- 49f106f: feat(i18n): rich text from catalog messages without HTML

  `rich(formatter, key, tags, vars)` from the new `@nifrajs/i18n/rich` entry formats a message like
  `t()` and turns its `<name>…</name>` and `<name/>` tags into calls to `tags[name]`, returning the
  message as text and whatever the handlers returned. Tags are bare names (no attributes); a tag
  without an own handler keeps its content as text, an unclosed or stray marker stays literal, and
  interpolated values and `#` are never read for tags. `renderRich(renderer, ...)` is the same for a
  UI framework.

  React, Preact, Solid and Vue export `rich(t, key, tags, vars)` from `/i18n`, returning one node
  (each handler receives its tag's content as one node, and `<br/>` renders a `<br>` unless `br` is
  given). Svelte exports `<Rich key tags vars>`, which takes one snippet per tag, and `rich()` for the
  parts array. `t()` is unchanged.

- 4936309: feat(i18n): one locale registry and locale-prefixed routing; feat(web): PWA manifest builder

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
  `matchSegment()` checks a `[lang]` route segment for a route `middleware` guard, answering not-found for
  an unknown or draft value and a redirect for the default's prefix or a wrong case. No path it builds
  can start with `//` or `/\`. No regex runs on request input.

  `@nifrajs/web/pwa-manifest` adds `pwaManifest()` - the declarative PWA half next to the
  service-worker generator. Pure builder for `manifest.json` bytes (names, scope defaulted
  from `start_url`, icons/screenshots/shortcuts, colors) with fail-loud validation of spec
  shapes, plus `serializeManifest()` and the `<link rel="manifest">` tag helper.

### Patch Changes

- Updated dependencies [dde125b]
- Updated dependencies [72b62fa]
- Updated dependencies [aa44e93]
- Updated dependencies [4a3ee60]
- Updated dependencies [aad6297]
- Updated dependencies [dad0d41]
- Updated dependencies [538adc2]
- Updated dependencies [f47edd1]
- Updated dependencies [df9530a]
- Updated dependencies [3e6973f]
- Updated dependencies [25e8edf]
- Updated dependencies [2b5e5fc]
- Updated dependencies [3b090de]
- Updated dependencies [da7d792]
- Updated dependencies [612a296]
- Updated dependencies [fb14dfa]
- Updated dependencies [8ae97f6]
- Updated dependencies [4af6f39]
- Updated dependencies [ca8b50d]
- Updated dependencies [b00a889]
- Updated dependencies [b53d64f]
- Updated dependencies [66fd712]
- Updated dependencies [9c3d524]
- Updated dependencies [738e7a1]
- Updated dependencies [4801cac]
- Updated dependencies [1b2d53a]
- Updated dependencies [25fe13d]
- Updated dependencies [0852290]
- Updated dependencies [0589dbe]
- Updated dependencies [2e2d8c0]
- Updated dependencies [856f5ce]
- Updated dependencies [18aa5aa]
- Updated dependencies [cfd86b3]
- Updated dependencies [8ff96c9]
- Updated dependencies [4c46199]
- Updated dependencies [eef4932]
- Updated dependencies [6de8686]
- Updated dependencies [d7892ea]
- Updated dependencies [4936309]
- Updated dependencies [ff5a779]
- Updated dependencies [bbdc5a1]
- Updated dependencies [10bc446]
- Updated dependencies [e8270d9]
- Updated dependencies [ff4a062]
- Updated dependencies [43ba944]
- Updated dependencies [46c741a]
- Updated dependencies [7bfa25e]
- Updated dependencies [4936309]
- Updated dependencies [6e257a6]
- Updated dependencies [4a03d30]
- Updated dependencies [8e30090]
- Updated dependencies [28f3aaf]
- Updated dependencies [6d20355]
- Updated dependencies [6907cbe]
- Updated dependencies [b64c3ee]
- Updated dependencies [bda9637]
- Updated dependencies [81c720e]
- Updated dependencies [ed60b23]
- Updated dependencies [a158b74]
- Updated dependencies [ff25d68]
  - @nifrajs/core@4.0.0

## 3.5.0

## 3.4.0

## 3.3.0

## 3.2.0

## 3.1.0

### Patch Changes

- 1400f6c: Portable response header, body, and raw-response observation is now enabled explicitly with `responseObserver()` from `@nifrajs/core/response-observer`. Official middleware that uses these tiers remains compatible and enables the runtime automatically.

## 3.0.0

### Patch Changes

- Updated dependencies [f3d2a35]
- Updated dependencies [6e43c15]
- Updated dependencies [f0fd370]
- Updated dependencies [86a555b]
- Updated dependencies [8c5f4cf]
- Updated dependencies [f0fd370]
- Updated dependencies [381bbf3]
- Updated dependencies [36801ae]
- Updated dependencies [9acadba]
- Updated dependencies [99fc683]
- Updated dependencies [73d894d]
  - @nifrajs/core@3.0.0

## 2.14.1

## 2.14.0

## 2.13.0

## 2.12.1

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
