import type { LoaderData } from "@nifrajs/client"
import { negotiateLocale } from "@nifrajs/i18n"
import { I18nProvider, useT } from "@nifrajs/web-react/i18n"
import { catalogs, locales } from "../catalogs"

export const meta = { title: "nifra — i18n demo" }

// Locale resolution: an explicit `?lang=` (the switcher) wins, else negotiate from Accept-Language
// (a cookie could persist the choice). All browser-safe — negotiateLocale is pure + the catalogs are
// data — so this loader bundles fine (no server-only leak). The loader returns ONLY the active locale's
// messages; the client provider + useT format from those serialized props.
export async function loader({ request }: { request: Request }) {
  const fromQuery = new URL(request.url).searchParams.get("lang")
  const locale =
    fromQuery !== null && (locales as readonly string[]).includes(fromQuery)
      ? fromQuery
      : negotiateLocale(request, { locales, defaultLocale: "en" })
  return { locale, messages: catalogs[locale] ?? catalogs.en }
}

function Content() {
  const { t, n } = useT()
  return (
    <section>
      <p id="greeting">{t("greeting", { name: "Ada" })}</p>
      <p id="cart">{t("cart", { count: 3 })}</p>
      <p id="price">{t("price", { amount: n(1299.99, { style: "currency", currency: "EUR" }) })}</p>
      <nav>
        {t("language")}: <a href="?lang=en">English</a> · <a href="?lang=fr">Français</a>
      </nav>
    </section>
  )
}

export default function Home(props: { data: LoaderData<typeof loader> }) {
  return (
    <I18nProvider locale={props.data.locale} messages={props.data.messages}>
      <Content />
    </I18nProvider>
  )
}
