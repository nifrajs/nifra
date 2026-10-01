---
"create-nifra": patch
---

Site and ISR scaffolds declare `@types/bun` and load its ambient types. The starter database rules in `nifra.assurance.ts` are optional, so an app without a database passes `nifra assure`; an import that matches a rule still grants its capabilities.

The ISR template's client build no longer copies `public/` into its own output directory.
