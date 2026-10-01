import type { LoaderData } from "@nifrajs/client"
import { I18nProvider, useT } from "@nifrajs/web-react/i18n"
import type { loader } from "./index.backend.ts"

export const meta = { title: "nifra - i18n demo" }

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
