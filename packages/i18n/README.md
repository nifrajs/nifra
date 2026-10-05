# @nifrajs/i18n

Framework-agnostic i18n for nifra - locale negotiation + a tiny ICU message formatter on the platform Intl. Dependency-free.

Part of the **[nifra](https://nifra.dev)** full-stack TypeScript framework - one core, five UI libraries, every runtime. Scaffold a new app with `bun create nifra`.

## Install

```sh
bun add @nifrajs/i18n
```

## Locales and URLs

Declare each locale once with `defineLocales()` - URL segment, BCP-47 tag, `hreflang`, direction and
native name, each defaulted from the segment - and bind it to a locale-prefixed URL scheme with
`@nifrajs/i18n/routing`:

```ts
import { defineLocales } from "@nifrajs/i18n"
import { defineI18nRouting } from "@nifrajs/i18n/routing"

export const locales = defineLocales({
  default: "en",
  locales: { en: {}, hi: { hreflang: "hi-IN" }, ur: { tag: "ur-PK" }, gu: { draft: true } },
})
export const urls = defineI18nRouting(locales)

urls.localizePathname("/kundli", "hi") // "/hi/kundli"
urls.alternates("/hi/kundli", { origin: "https://example.com" }) // { canonical, links } with hreflang
urls.matchSegment("gu", "/gu/kundli") // { kind: "not-found" } - a draft is never served
locales.documentMeta("ur") // { lang: "ur-PK", dir: "rtl" }
```

Guard a `[lang]` route segment with `matchSegment()` in `routes/[lang]/_middleware.ts`: an unknown or
draft value answers 404, and the default's prefix (`/en/...`) or a wrong case redirects.

## Messages

`createFormatter(locale, messages, options)` formats ICU messages: interpolation, `plural`,
`selectordinal` and `select`, nested, with `#` in the locale's own number format. Catalogs may nest
(messages, lists, blocks) and are read with dotted keys; `get(key)` returns a list or block whole. A
key the catalog lacks is tried in each `fallback` catalog, then `onMissing` fires once and the key is
returned. `timeZone` and `numberingSystem` set defaults for `d()`, `n()` and `#`.

```ts
import { createFormatter } from "@nifrajs/i18n"

const t = createFormatter("fr-CA", catalogs["fr-CA"], {
  fallback: locales.chain("fr-CA").slice(1).map((key) => catalogs[key]), // fr, then en
  onMissing: reportMissingKey, // a stable function: formatters are cached per handler
  timeZone: user.timeZone,
})
t.t("cart", { count: 1200 }) // "1 200 articles"
```

Declare `interface Register { messages: typeof en }` on `@nifrajs/i18n` once, and every `t()` key
(adapters' `useT()` included) and every `Translation`-typed catalog is checked against `en`.

`rich(formatter, key, tags, vars)` from `@nifrajs/i18n/rich` renders a message's tags
(`<b>…</b>`, `<icon/>`, names only) with your handlers instead of HTML: a tag without a handler
keeps its content as text, and interpolated values are never read for tags. Each adapter's `/i18n`
entry exports a `rich()` that returns framework nodes (Svelte: `<Rich>` with one snippet per tag).

`localeCookie(name, locale)` is the browser half of the detector's `persist` cookie: assign it to
`document.cookie` in a language switcher and it is byte-identical to the detector's `Set-Cookie`.

## Checking catalogs

`checkCatalogs({ locales, catalogs, ignore })` from `@nifrajs/i18n/check` reports coverage, missing
and unused keys, ICU syntax errors, placeholder and rich-tag parity with the default message, plural
cases the locale's grammar needs, script purity (`Intl.Locale(tag).maximize().script` against Unicode
script properties - a Telugu sign in Gujarati, a Cyrillic `е` in English), and untranslated messages.
It is pure; `nifra i18n check [entry]` runs it over the module exporting `locales` and `catalogs`.

## Locale detection

`negotiateLocale()` / `resolveLocale()` are pure: query parameter → cookie → `Accept-Language` →
default, always answering from your `locales` allow-list (request input is matched, never echoed).
The server plugin lives at `@nifrajs/i18n/detector` and needs `@nifrajs/core`:

```ts
import { localeDetector } from "@nifrajs/i18n/detector"

app.use(
  localeDetector({
    locales: ["en", "fr", "de"],
    defaultLocale: "en",
    queryParam: "lang",
    cookie: "locale",
    persist: true, // pin an explicit ?lang= choice into the cookie
  }),
)
// handlers see c.locale / c.localeSource; responses carry Content-Language
```

## Docs

- Reference: <https://nifra.dev/docs>
- AI-readable: <https://nifra.dev/llms.txt>

MIT

## For AI agents

Start with [`LLM.md`](./LLM.md) - this package's contract card (the exports you call + its footguns),
one cheap read instead of the whole corpus. For the wider framework: the repo's
[`AGENTS.md`](../../AGENTS.md) is the copy-paste quick reference, and
[`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run `nifra check` as the
done-gate, or `nifra mcp` to give the agent live project tools.
