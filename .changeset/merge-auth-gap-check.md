---
"@nifrajs/core": minor
"@nifrajs/cli": minor
---

`nifra check` reports NF-C043, a warning, for a `merge()` whose server authenticates none of its routes while the server it is merged into authenticates its own with `authenticate()` or an auth plugin that records `authenticated` for the routes after it. A merged route keeps the hooks of the server that declared it, so that authentication never runs for it. A merged server that authenticates any route of its own is not reported. `// nifra-expect NF-C043: <reason>` on the merge line accepts a module that is public on purpose. The rule reads the app `nifra.assurance.ts` loads.

`@nifrajs/core/reflection` exports `reflectMergeAuthGaps(app)`, the record behind the rule, collected by a development load.
