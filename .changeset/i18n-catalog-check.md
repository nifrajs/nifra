---
"@nifrajs/i18n": minor
"@nifrajs/cli": minor
---

feat(i18n): catalog checks - `checkCatalogs()` and `nifra i18n check`

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
