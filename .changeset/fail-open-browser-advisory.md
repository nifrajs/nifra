---
"@nifrajs/cli": patch
---

NF-S001 (a gate whose catch block fails open) is a warning, not an error, in browser code proven to belong to a nifra web app (a route's page, `frontend/`), the same proof NF-S002 already uses: a check that fails open in the browser grants nothing the server does not check again. Backend, shared, API-only and unclassified files still fail the check, a `// nifra-expect NF-S001: <reason>` comment still makes the finding information, and the retired `@nifra-gate-reviewed` marker still silences nothing.
