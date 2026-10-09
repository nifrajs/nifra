---
"@nifrajs/cli": minor
---

`"nifra": { "kind": "api" }` in package.json declares a project that serves no pages. `nifra check` reads it from the nearest package.json, statically, and there skips the checks that read zones (NF-C028 to NF-C033) and the server-only import check (NF-C004), and treats every file as server code for NF-S002. A directory with web config (`nifra.config.ts` exporting `adapter`, or `backend/framework.ts`) keeps its zone checks under the setting, and NF-C037 reports the clash as an error. A value other than `"api"` or `"web"` is an NF-C028 error naming the file. An NF-C028 or NF-C004 finding outside any web app now names the setting. Builds and dev servers do not read it.
