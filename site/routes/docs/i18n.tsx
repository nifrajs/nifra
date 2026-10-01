import { CodeBlock } from "../../highlight"
import { docsMeta } from "../../meta"

// Pure content page - no React interactivity (TOC/copy/search are the layout enhancer +
// the Nira island), so ship zero framework JS and avoid hydrating the inline-script DOM.
export const hydrate = false

export const meta = docsMeta(
  "/docs/i18n",
  "Nifra - i18n",
  "One locale registry, locale-prefixed routing, negotiation and a tiny ICU message formatter on the platform Intl.",
)

const LOCALES = `// lib/i18n.ts - each locale declared once; routing, alternates and <html lang>/<html dir> read it.
import { defineLocales } from "@nifrajs/i18n"
import { defineI18nRouting } from "@nifrajs/i18n/routing"

export const locales = defineLocales({
  default: "en",
  locales: {
    en: { hreflang: "en-IN" },
    hi: { hreflang: "hi-IN" },
    ur: { tag: "ur-PK", hreflang: "ur" }, // dir "rtl", derived from the tag
    gu: { draft: true }, // catalogs in progress: never routed, never an alternate
  },
})
export const urls = defineI18nRouting(locales)

urls.localizePathname("/kundli", "hi") // "/hi/kundli"
locales.chain("hi") // ["hi", "en"] - the catalog fallback order`

const GUARD = `// routes/[lang]/_middleware.ts - 404 unknown and draft locales, redirect /en/... to /...
import { defineLocales } from "@nifrajs/i18n"
import { defineI18nRouting } from "@nifrajs/i18n/routing"
import { notFound, type RouteMiddleware, redirect } from "@nifrajs/web"

const urls = defineI18nRouting(
  defineLocales({ default: "en", locales: { en: {}, hi: {}, gu: { draft: true } } }),
)

const guard: RouteMiddleware = (ctx) => {
  const { pathname, search } = new URL(ctx.request.url)
  const match = urls.matchSegment(ctx.params.lang, pathname + search)
  if (match.kind === "not-found") notFound()
  if (match.kind === "redirect") return redirect(match.location, { status: 308 })
  return undefined
}
export default guard`

const ALTERNATES = `// routes/[lang]/kundli.tsx - canonical + hreflang links and the document language.
import { defineLocales } from "@nifrajs/i18n"
import { defineI18nRouting } from "@nifrajs/i18n/routing"
import type { Meta, MetaArgs } from "@nifrajs/web"

const urls = defineI18nRouting(
  defineLocales({ default: "en", locales: { en: {}, hi: { hreflang: "hi-IN" }, ur: { tag: "ur-PK" } } }),
)

export function meta({ params, origin }: MetaArgs): Meta {
  const lang = params.lang ?? ""
  const locale = urls.locales.isServed(lang) ? lang : urls.locales.default
  // Every page of this cluster passes the same locales, so the alternates stay reciprocal.
  const { canonical, links } = urls.alternates(urls.localizePathname("/kundli", locale), { origin })
  return {
    ...urls.locales.documentMeta(locale),
    link: [
      { rel: "canonical", href: canonical },
      ...links.map((link) => ({ rel: "alternate", hreflang: link.hreflang, href: link.href })),
    ],
  }
}`

const NEGOTIATE = `// In a loader: resolve the locale + return only that catalog's messages.
import { negotiateLocale } from "@nifrajs/i18n"
import { catalogs, locales } from "../catalogs"

export async function loader({ request }: { request: Request }) {
  const locale = negotiateLocale(request, { locales, defaultLocale: "en", queryParam: "lang", cookie: "lang" })
  return { locale, messages: catalogs[locale] }   // ?lang= → cookie → Accept-Language → default
}`

const DETECTOR = `// Or as a server plugin: c.locale on every handler, Content-Language on every response.
import { server } from "@nifrajs/core"
import { localeDetector } from "@nifrajs/i18n/detector"

const app = server().use(localeDetector({
  locales: ["en", "fr", "de"],
  defaultLocale: "en",
  queryParam: "lang",
  cookie: "locale",
  persist: true,        // pin an explicit ?lang= choice into the cookie
})).get("/", (c) => c.json({ locale: c.locale, via: c.localeSource }))`

const PROVIDER = `// The page provides the formatter; components read it with useT().
import { localeCookie } from "@nifrajs/i18n"
import { I18nProvider, useT } from "@nifrajs/web-react/i18n"

export default function Page({ data }) {
  // data.fallback: the catalogs locales.chain(locale) names after the page's own, from the loader.
  return (
    <I18nProvider locale={data.locale} messages={data.messages} fallback={data.fallback}>
      <Body />
    </I18nProvider>
  )
}

function Body() {
  const { t, get, n, d } = useT()
  return <>
    <p>{t("home.title", { name: "Ada" })}</p>
    <p>{t("cart", { count: 1200 })}</p>          {/* "1,200 items" - # in the locale's format */}
    <p>{t("place", { rank: 2 })}</p>             {/* "You finished 2nd" */}
    <p>{n(1299.99, { style: "currency", currency: "EUR" })}</p>
    <p>{d(Date.now(), { dateStyle: "long" })}</p>
    <ul>{get("faq")?.map((item) => <li key={item.q}>{item.q}</li>)}</ul>
    {/* Same cookie name and attributes as localeDetector({ persist: true }) */}
    <button onClick={() => { document.cookie = localeCookie("locale", "hi"); location.reload() }}>
      हिन्दी
    </button>
  </>
}`

const CATALOG = `// messages/en.ts - the default locale's catalog: ICU strings, lists and nested blocks.
import { createFormatter, type PartialMessages } from "@nifrajs/i18n"

export const en = {
  cart: "{count, plural, =0 {empty} one {# item} other {# items}}",
  place: "You finished {rank, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}",
  home: { title: "Welcome back, {name}" },
  faq: [{ q: "Is it free?", a: "Yes." }],
}

// Another locale is partial; a key it lacks falls back to the next catalog.
export const fr: PartialMessages<typeof en> = {
  cart: "{count, plural, =0 {vide} one {# article} other {# articles}}",
}

const t = createFormatter<typeof en>("fr", fr, {
  fallback: [en],
  onMissing: (key, locale) => console.warn(\`missing \${locale} translation: \${key}\`),
  timeZone: "Europe/Paris",
})
t.t("cart", { count: 1200 }) // "1 200 articles"
t.t("home.title", { name: "Ada" }) // "Welcome back, Ada", from en
const questions = t.get("faq")?.map((item) => item.q)
console.log(questions)`

const REGISTER = `// doc-check: skip - declares the app-wide catalog type, which would retype every other sample here.
// Once, anywhere in the app: every t() key, useT() included, and every other catalog is checked.
import type { en } from "./messages/en"

declare module "@nifrajs/i18n" {
  interface Register {
    messages: typeof en
  }
}`

export default function I18n() {
  return (
    <div className="prose">
      <h1 className="page">i18n</h1>
      <p className="lead">
        <code>@nifrajs/i18n</code> is framework-agnostic and dependency-free - one locale registry,
        locale-prefixed routing, locale negotiation and a tiny ICU message formatter built on the
        platform <code>Intl</code>. It runs on every runtime; you bring the catalogs.
      </p>

      <h2>Declare your locales</h2>
      <p>
        <code>defineLocales</code> is the one place a locale is declared: its URL segment, the BCP-47
        tag <code>Intl</code> formats with, the <code>hreflang</code> value search engines match, its
        writing direction and its own name for a language switcher. Each defaults from the segment, and
        the direction is derived from the tag (an explicit script, a right-to-left language such as
        Urdu, Arabic or Hebrew, or the runtime's likely script). A <code>draft</code> locale keeps its
        catalogs but is never served, so a half-translated language cannot be indexed under its own
        URL. Bad tags, unsafe segments and two locales sharing an <code>hreflang</code> throw at
        definition.
      </p>
      <CodeBlock code={LOCALES} lang="ts" />

      <h2>Locale-prefixed URLs</h2>
      <p>
        <code>@nifrajs/i18n/routing</code> binds the registry to a URL scheme where the locale is the
        first path segment and the default is unprefixed (or prefixed too, with{" "}
        <code>prefixDefaultLocale</code>). A <code>[lang]</code> route segment matches any string, so
        guard it: <code>matchSegment</code> answers not-found for an unknown or draft value and a
        redirect for the default's prefix or a wrong case, and a <code>_middleware.ts</code> in the{" "}
        <code>[lang]</code> directory turns that into a 404 through your <code>_404</code> page or a
        permanent redirect - on full page loads, client navigations and form posts alike.
      </p>
      <CodeBlock code={GUARD} lang="ts" />
      <p>
        <code>alternates(path, {`{ origin, locales }`})</code> gives the page's canonical URL and its{" "}
        <code>hreflang</code> links, built exactly as <code>localizePathname</code> builds them. Without{" "}
        <code>origin</code> the URLs are root-relative, for a language switcher. A page that exists in
        only some languages passes those <code>locales</code>; the links come out in registry order, so
        every page of the cluster lists the same set and search engines accept it. A redirect or link it
        builds can never start with <code>//</code>.
      </p>
      <CodeBlock code={ALTERNATES} lang="ts" />

      <h2>Negotiate the locale</h2>
      <p>
        <code>negotiateLocale</code> picks the best supported locale from a <code>?lang=</code> query
        parameter (an explicit ask), then a cookie (a remembered choice), then
        <code> Accept-Language</code> (quality-ranked, with <code>fr-CA</code>→<code>fr</code>
        base-subtag fallback), else your default. The answer is always drawn from your
        <code> locales</code> allow-list - request input is matched, never echoed - so a hostile
        <code> ?lang=</code> can't reach the response. Resolve it in a loader and return just that
        locale's messages.
      </p>
      <CodeBlock code={NEGOTIATE} />
      <p>
        On the server, <code>localeDetector()</code> (from <code>@nifrajs/i18n/detector</code>, needs
        <code> @nifrajs/core</code>) wraps the same negotiation as a plugin: handlers read
        <code> c.locale</code>/<code>c.localeSource</code>, responses carry
        <code> Content-Language</code>. With <code>persist: true</code> it writes the locale cookie
        <b> only</b> when an explicit <code>?lang=</code> choice differs from the cookie - a
        header-derived guess is never pinned, and plain requests never grow a{" "}
        <code>Set-Cookie</code>, so responses stay cacheable. (<code>@nifrajs/middleware</code>'s
        <code> language()</code> is the header-only sibling; use one or the other.)
      </p>
      <CodeBlock code={DETECTOR} />

      <h2>Format messages</h2>
      <p>
        <code>createFormatter(locale, messages, options)</code> →{" "}
        <code>{`{ t, get, n, d }`}</code>. <code>t</code> handles interpolation (
        <code>{`{name}`}</code>), <code>plural</code> (with <code>=N</code> exact cases),{" "}
        <code>selectordinal</code> (1st, 2nd, 3rd) and <code>select</code>, nested - via a
        hand-written parser + <code>Intl.PluralRules</code>. Inside a plural, <code>#</code> is the
        number in the locale's own format. <code>n</code>/<code>d</code> are memoized{" "}
        <code>Intl.NumberFormat</code>/<code>DateTimeFormat</code>.
      </p>
      <p>
        A catalog can nest: values are messages, lists or blocks, read with dotted keys (
        <code>t("home.title")</code>); a flat key containing a dot is still found first.{" "}
        <code>get(key)</code> returns a list or block whole, for an FAQ or a page's copy. A key the
        catalog lacks is tried in each <code>fallback</code> catalog in order (
        <code>locales.chain(locale)</code> gives <code>fr-CA</code> → <code>fr</code> → the default);
        only when none has it does <code>onMissing</code> fire, once per key, and <code>t</code>{" "}
        return the key. <code>timeZone</code> and <code>numberingSystem</code> set defaults for every{" "}
        <code>d()</code>, <code>n()</code> and <code>#</code>. Formatters are cached per catalog and
        options, so pass a stable <code>onMissing</code>.
      </p>
      <CodeBlock code={CATALOG} lang="ts" />
      <p>
        To type every key once, register the default catalog. A typo in <code>t()</code> is then a
        compile error everywhere, and other locales' catalogs (typed <code>Translation</code>) are
        checked against its shape.
      </p>
      <CodeBlock code={REGISTER} lang="ts" />
      <p>In React, provide it once and read it with <code>useT()</code>:</p>
      <CodeBlock code={PROVIDER} />
      <p>
        <code>locale</code>, <code>messages</code> and <code>fallback</code> are serializable, so SSR
        renders the negotiated catalogs and the client rebuilds the same formatter on hydrate - no
        mismatch. Switching language re-navigates (a cookie or <code>?lang=</code>); the loader returns
        the new catalog and the page re-renders. <code>localeCookie(name, locale)</code> builds the
        detector's own cookie for a switcher, so a choice made in the page and one made through{" "}
        <code>?lang=</code> are the same cookie.
      </p>

      <h2>Notes</h2>
      <ul>
        <li>For many locales, load catalogs <b>lazily</b> per request - don't bundle every catalog. A
          loader that does <code>{"await import(`../messages/${locale}.ts`)"}</code> ships only the
          requested locale's table to the page, typed inline tables included.</li>
        <li>The supported ICU subset is interpolation + <code>plural</code>/<code>selectordinal</code>/<code>select</code>; use
          <code> n()</code>/<code>d()</code> for inline numbers/dates (no <code>{`{n, number}`}</code>
          skeletons). <code>Intl.MessageFormat</code> isn't widely available yet, so this is the
          portable core.</li>
        <li><code>&lt;I18nProvider&gt;</code> + <code>useT()</code> ship for <b>all five adapters</b>
          (React, Preact, Vue, Solid, Svelte) - import from <code>@nifrajs/web-&lt;framework&gt;/i18n</code>;
          each is a thin binding over the agnostic <code>createFormatter</code>.</li>
      </ul>
    </div>
  )
}
