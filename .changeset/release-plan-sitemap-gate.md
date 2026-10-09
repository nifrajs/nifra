---
"@nifrajs/cli": patch
---

`nifra verify --release` runs the sitemap gate (`check:sitemap`), which the default plan already ran. The full release plan skipped it, so a docs page added or removed without regenerating the sitemap passed release verification.
