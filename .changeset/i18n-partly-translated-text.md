---
"@nifrajs/i18n": minor
"@nifrajs/cli": minor
---

`checkCatalogs()` catches partly translated text. In a locale that does not write in Latin, `latin-share` reports a message of at least `minWords` (6) words whose share of Latin-script words is above `maxLatinShare` (0.6), with words split by `Intl.Segmenter` so Japanese and Thai count too; `latinWords` lists the brands and units a translation keeps. Each such locale's coverage row carries its `latinShare`, with a warning above `maxLocaleLatinShare` (0.1). `volume` reports a default message of at least `minVolumeGraphemes` (80) graphemes translated to under `minVolumeRatio` (0.32) of its length, a summary rather than a translation; Han scripts are left out of it. `rules` adds an app's own checks, run on every message of every locale and reported as `custom:<code>`, which `ignore` takes. `nifra i18n check` reads these options from the entry's `check` export and shows each locale's Latin share.
