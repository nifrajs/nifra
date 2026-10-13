---
"@nifrajs/cli": minor
---

`nifra explain NF-C007` (and `nifra_explain` given a code as its `error`) answers a `nifra check` rule code from the catalog: its title, the review check it reports under, what it reports and why it matters, the fix, the command that applies or starts it when there is one, and its docs page. An unknown or retired code is refused with exit 1 instead of being explained as an unhandled error.
