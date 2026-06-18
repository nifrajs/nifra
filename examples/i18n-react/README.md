# i18n-react — locale negotiation + ICU formatting on nifra

A nifra + React app demonstrating `@nifrajs/i18n`: **locale negotiation**, an **ICU message formatter**
(plural, interpolation), locale-aware **number/currency** formatting, and a **language switcher**.

```sh
bun run examples/i18n-react/build.ts
bun examples/i18n-react/server.ts        # http://localhost:3000  (try ?lang=fr)
```

- The loader resolves the locale (`?lang=` wins, else `Accept-Language` via `negotiateLocale`) and
  returns `{ locale, messages }` (only the active catalog).
- The page wraps in `<I18nProvider locale messages>`; components call `useT()` → `{ t, n, d }`.
  `t("cart", { count: 3 })` formats the ICU plural; `n(1299.99, { style: "currency", currency: "EUR" })`
  formats per locale (`€1,299.99` in en, `1 299,99 €` in fr).
- Switching language re-navigates → the loader returns the new catalog → re-render.

`negotiateLocale` and the catalogs are browser-safe data, so the loader bundles cleanly. For many
locales, load catalogs lazily (per request) rather than importing them all.
