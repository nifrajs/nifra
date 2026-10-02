import { negotiateLocale } from "@nifrajs/i18n"
import { t } from "@nifrajs/schema"
import { catalogs, locales } from "../backend/catalogs"

export const loaderOutput = t.object({ locale: t.string(), messages: t.record(t.string()) })

// Locale resolution: an explicit `?lang=` (the switcher) wins, else negotiate from Accept-Language
// (a cookie could persist the choice). All browser-safe - negotiateLocale is pure + the catalogs are
// data - so this loader bundles fine (no server-only leak). The loader returns ONLY the active locale's
// messages; the client provider + useT format from those serialized props.
export async function loader({ request }: { request: Request }) {
  const fromQuery = new URL(request.url).searchParams.get("lang")
  const locale =
    fromQuery !== null && (locales as readonly string[]).includes(fromQuery)
      ? fromQuery
      : negotiateLocale(request, { locales, defaultLocale: "en" })
  return { locale, messages: catalogs[locale] ?? catalogs.en }
}
