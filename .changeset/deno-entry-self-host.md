---
"@nifrajs/deno": minor
"@nifrajs/web": minor
"@nifrajs/cli": minor
---

`@nifrajs/deno`'s `serve` takes `static`, a handler that sees every request before the app does. It answers with a response, or hands the request to the app with `undefined`. A file it answers wins over any route at the same path, no hook of the app runs for it, and a throw answers a plain `500`.

`nifra build --target deno` emits a server that runs on `@nifrajs/deno`'s `serve` and serves its client bundle and public files through `static`, so a Deno app installs `@nifrajs/deno` of the same release, as a Node app installs `@nifrajs/node`. The built server serves WebSocket routes, and `stop()` drains its in-flight requests. With an older adapter installed the build stops before bundling and names both versions.

A built Deno server serves its static files again. Bun's browser stand-in for `node:crypto`, which the Deno entry tags files with, has no working `createHash`, so every file answered `404` and pages loaded without their client bundle. The Deno server bundle now imports `node:crypto` from Deno itself, and a `--vite` Deno build no longer refuses it as an edge built-in. `buildServer` and `buildServerVite` take `providedBuiltins`, the Node built-ins the runtime that runs the bundle has besides what its target implies.

`nifra.config.ts` takes `selfHost`, the settings the server a `bun`, `node` or `deno` build emits starts with, `nifra start` included. `gracefulSignals` (`true`, or `{ drainMs, delayMs }`) drains the server on SIGTERM and SIGINT instead of letting the signal kill it. `idleTimeoutSec` is how long a Bun server keeps a connection that moves no bytes, from `0` (never) to 255; Node and Deno ignore it, and an edge build ignores `selfHost`. `buildTarget` and `generateServerEntry` take the same `selfHost` and refuse a value of the wrong shape before building.
