---
"@nifrajs/i18n": minor
"@nifrajs/web-react": minor
"@nifrajs/web-preact": minor
"@nifrajs/web-solid": minor
"@nifrajs/web-vue": minor
"@nifrajs/web-svelte": minor
---

feat(i18n): selectordinal, fallback catalogs, typed nested catalogs and the locale cookie

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
