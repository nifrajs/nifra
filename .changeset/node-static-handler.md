---
"@nifrajs/node": minor
"@nifrajs/web": patch
---

`@nifrajs/node`'s `serve` takes `static` as a function, the same option as Bun's `app.listen()` and `@nifrajs/deno`'s `serve`. It sees every request before the app does and answers with a response, or hands the request to the app with `undefined`. A throw or a rejection answers a plain `500`.

Mounts move into `serveStatic(mounts)`, which takes the options `static` took before:

```ts
// before
await serve(app, { port: 3000, static: { dir: new URL("./assets/", import.meta.url) } })
// after
await serve(app, { port: 3000, static: serveStatic({ dir: new URL("./assets/", import.meta.url) }) })
```

`serve` runs `serveStatic`'s mounts on Node's own request, so a request they pass on still reaches the app on its direct lane. Any other function needs a Web `Request` for every request. Called with a Web `Request`, `serveStatic`'s function answers as its mounts do. A mount object passed to `static` is refused with a `TypeError` that names `serveStatic`.

`nifra build --target node` emits `static: serveStatic([...])`.
