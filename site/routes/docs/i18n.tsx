import { CodeBlock } from "../../highlight"
import { pageMeta } from "../../meta"

// Pure content page - no React interactivity (TOC/copy/search are the layout enhancer +
// the Nira island), so ship zero framework JS and avoid hydrating the inline-script DOM.
export const hydrate = false

export const meta = pageMeta(
  "Nifra - i18n",
  "Locale negotiation + a tiny ICU message formatter on the platform Intl, framework-agnostic.",
  "/docs/i18n",
)

const NEGOTIATE = `// In a loader: resolve the locale + return only that catalog's messages.
import { negotiateLocale } from "@nifrajs/i18n"
import { catalogs, locales } from "../catalogs"

export async function loader({ request }: { request: Request }) {
  const locale = negotiateLocale(request, { locales, defaultLocale: "en", queryParam: "lang", cookie: "lang" })
  return { locale, messages: catalogs[locale] }   // ?lang= → cookie → Accept-Language → default
}`

const DETECTOR = `// Or as a server plugin: c.locale on every handler, Content-Language on every response.
import { localeDetector } from "@nifrajs/i18n/detector"

app.use(localeDetector({
  locales: ["en", "fr", "de"],
  defaultLocale: "en",
  queryParam: "lang",
  cookie: "locale",
  persist: true,        // pin an explicit ?lang= choice into the cookie
})).get("/", (c) => c.json({ locale: c.locale, via: c.localeSource }))`

const PROVIDER = `// The page provides the formatter; components read it with useT().
import { I18nProvider, useT } from "@nifrajs/web-react/i18n"

export default function Page({ data }) {
  return <I18nProvider locale={data.locale} messages={data.messages}><Body/></I18nProvider>
}

function Body() {
  const { t, n, d } = useT()
  return <>
    <p>{t("greeting", { name: "Ada" })}</p>
    {/* ICU plural with # substitution */}
    <p>{t("cart", { count: 3 })}</p>            {/* "3 items in your cart" */}
    <p>{t("price", { amount: n(1299.99, { style: "currency", currency: "EUR" }) })}</p>
    <p>{d(Date.now(), { dateStyle: "long" })}</p>
  </>
}`

const CATALOG = `// catalogs: plain JSON per locale (ICU strings). Bring your own.
export const catalogs = {
  en: { greeting: "Hello, {name}!", cart: "{count, plural, =0 {empty} one {# item} other {# items}}" },
  fr: { greeting: "Bonjour, {name} !", cart: "{count, plural, =0 {vide} one {# article} other {# articles}}" },
}`

export default function I18n() {
  return (
    <div className="prose">
      <h1 className="page">i18n</h1>
      <p className="lead">
        <code>@nifrajs/i18n</code> is framework-agnostic and dependency-free - locale negotiation plus a
        tiny ICU message formatter built on the platform <code>Intl</code>. It runs on every runtime;
        you bring JSON catalogs.
      </p>

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
        <code>createFormatter(locale, messages)</code> → <code>{`{ t, n, d }`}</code>. <code>t</code>
        handles interpolation (<code>{`{name}`}</code>), <code>plural</code> (with <code>=N</code> exact
        cases and <code>#</code> → the number) and <code>select</code>, nested - via a hand-written
        parser + <code>Intl.PluralRules</code>. <code>n</code>/<code>d</code> are memoized
        <code> Intl.NumberFormat</code>/<code>DateTimeFormat</code>. A missing key returns the key.
      </p>
      <CodeBlock code={CATALOG} />
      <p>In React, provide it once and read it with <code>useT()</code>:</p>
      <CodeBlock code={PROVIDER} />
      <p>
        Both <code>locale</code> and <code>messages</code> are serializable, so SSR renders the
        negotiated catalog and the client rebuilds the same formatter on hydrate - no mismatch.
        Switching language re-navigates (a cookie or <code>?lang=</code>); the loader returns the new
        catalog and the page re-renders.
      </p>

      <h2>Notes</h2>
      <ul>
        <li>For many locales, load catalogs <b>lazily</b> per request - don't bundle every catalog.</li>
        <li>The supported ICU subset is interpolation + <code>plural</code>/<code>select</code>; use
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
