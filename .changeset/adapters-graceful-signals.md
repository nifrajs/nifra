---
"@nifrajs/node": minor
"@nifrajs/deno": minor
"@nifrajs/web": patch
---

`@nifrajs/node`'s and `@nifrajs/deno`'s `serve` take `gracefulSignals` in place of `signals`, the name Bun's `server({ gracefulSignals })` already uses. The value is unchanged: `true`, or the `{ drainMs, delayMs }` passed to `stop()`.

```ts
// before
await serve(app, { port: 3000, signals: { drainMs: 8_000 } })
// after
await serve(app, { port: 3000, gracefulSignals: { drainMs: 8_000 } })
```

A `signals` option is refused with a `TypeError` that names `gracefulSignals`, so a server cannot start without the signal handling it asked for. `nifra build --target node` and `--target deno` emit `gracefulSignals`.
