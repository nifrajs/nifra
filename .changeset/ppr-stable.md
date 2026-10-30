---
"@nifrajs/web": minor
"@nifrajs/web-react": minor
"@nifrajs/web-preact": minor
"@nifrajs/web-vue": minor
"@nifrajs/web-svelte": minor
"@nifrajs/web-solid": minor
"@nifrajs/cli": minor
---

Partial prerendering is no longer experimental. `createWebApp` takes it as `ppr`, where it was `experimental.ppr`, and the `experimental` option is gone: passing it throws a `TypeError` that names `ppr`, and the startup errors name `ppr.origin`, `ppr.deployment` and `ppr.store`. `nifra upgrade` moves `experimental: { ppr }` to `ppr` in a `createWebApp` options literal and lists any other `experimental` shape it finds there by line (options spread in, or built in another file, are yours to check). `nifra scaffold` is stable.
