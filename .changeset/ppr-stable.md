---
"@nifrajs/web": minor
"@nifrajs/web-react": minor
"@nifrajs/web-preact": minor
"@nifrajs/web-vue": minor
"@nifrajs/web-svelte": minor
"@nifrajs/web-solid": minor
"@nifrajs/cli": minor
---

Partial prerendering is no longer experimental. `createWebApp` takes it as `ppr`, where it was `experimental.ppr`, and the `experimental` option is gone: passing it throws a `TypeError` that names `ppr`, and the startup errors name `ppr.origin`, `ppr.deployment` and `ppr.store`. `nifra upgrade` moves `experimental: { ppr }` to `ppr` in a `createWebApp` call and lists any other shape by line. `nifra scaffold` is stable.
