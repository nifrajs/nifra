---
"@nifrajs/cli": patch
---

`nifra check` reports NF-C044, a warning, for a `createWebApp` call that passes a `clientEntry` and no `copyChunks` in an app with copy tables (`@nifrajs/i18n/copy`). A production client build moves the tables into one chunk per locale that a page loads from the `copyChunks` its server lists, so such a server fails on the first page that renders copy, while `nifra dev` (which never splits) and e2e pass. The finding names the server manifest the module already imports from, which exports `copyChunks`; `// nifra-expect NF-C044: <reason>` on the call accepts a server that never serves those pages. An app on TypeScript 7, whose build keeps tables whole, is not reported.
