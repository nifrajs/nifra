---
"@nifrajs/core": patch
"@nifrajs/node": patch
"@nifrajs/deno": patch
"@nifrajs/cli": patch
---

`server({ gracefulSignals: { drainMs } })`, and `serve(app, { signals: { drainMs } })` on Node and Deno, set how long in-flight requests get to finish when SIGTERM or SIGINT stops the server before the stop forces them closed. `true` keeps the 10 second default. `nifra doctor` counts the object form as a graceful lifecycle.
