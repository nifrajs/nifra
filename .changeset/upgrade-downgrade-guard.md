---
"@nifrajs/cli": minor
---

`nifra upgrade` refuses to roll a dependency backward, and duplicate-install diagnostics name the type-inference symptom.

`nifra upgrade <version>` now fails closed when a target would set any pin below the installed version (for example running an older recipe on a newer install), listing each pin that would roll back and writing nothing; pass `--allow-downgrade` to apply it intentionally. `nifra doctor` and `nifra check` additionally call out that a second `@nifrajs/core` copy is the usual cause of `typeof backend` collapsing to `any` at `.merge()`.
