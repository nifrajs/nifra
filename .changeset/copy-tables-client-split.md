---
"@nifrajs/web": minor
"@nifrajs/web-solid": patch
---

A production client build (Bun or Vite) moves copy tables (`@nifrajs/i18n/copy`) into one chunk per locale, so a page's JavaScript carries the copy of the locale it renders in and none of the others; the server bundle keeps every table whole. The client manifest lists the chunks as `copyChunks`, the generated server entry passes them to the new `createWebApp({ copyChunks })` option (a hand-written entry passes the manifest's), and each page hands the map to the browser and preloads the chunks it reads: its URL's locale and the one its `<html lang>` names. A client navigation loads the next URL's chunk with the route's code; the router passes the target path to `loadModule` for that. The build reads tables with the app's TypeScript (5.9 or 6) and warns and leaves them whole without one; `buildClient({ copySplit: false })` turns it off. `readSource()` and `addSourceTransform()` in `@nifrajs/web/plugins/kit` let a plugin that claims a file still compile the rewritten source; the Solid and StyleX plugins read through it.
