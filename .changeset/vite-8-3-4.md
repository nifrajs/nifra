---
"@nifrajs/web": minor
"create-nifra": patch
---

The server-component pipeline is certified on Vite 8.3.4, which carries the fix for GHSA-698v-4r3x-3vcv (an unescaped `%` in the dev server's open-in-editor command on Windows). An app on the pipeline pins `vite` to exactly 8.3.4; until it does, the plugin's guard stops the build. A new `create-nifra` site asks for `vite` `^8.3.4`.
