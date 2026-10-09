---
"@nifrajs/cli": minor
---

`nifra check` treats the mounts its assurance source declares `opaque` (a better-auth handler mounted with `mounts: [{ path, app, opaque }]`) as external mounts, so a `fetch` into one is no longer reported as a hand-rolled API call. A mount without that declaration, and a path that escapes the prefix with `..`, are still checked. The prefixes are listed with the `nifra.check.json` `externalMounts` in the report.
