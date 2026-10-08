---
"@nifrajs/core": minor
"@nifrajs/cli": minor
---

`reflectHooks(server)` from `@nifrajs/core/reflection` reports, for every route and for each prefix's unmatched paths, the hooks that run in order: their kind, the plugin or function name, and the site that registered them (`app`, `group <prefix>`, `merge #n`, `mount <path>`). Static `responseHeaders()` declarations appear with their header names. Origins are recorded only outside production builds; a production report sets `complete: false`.

`nifra routes --hooks [--json]` prints that report, and `--since <file>` prints only what runs differently from a saved one. `nifra upgrade --write` saves the report to `.nifra/hooks-before-upgrade.json` before it edits anything and prints the hook-scope diff (`--no-hooks` skips it). `nifra check --json` includes the report as `hooks` when `nifra.assurance.ts` names a `source`.
