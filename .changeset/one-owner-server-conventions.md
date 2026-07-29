---
"@nifrajs/web": minor
"@nifrajs/cli": patch
---

`nifra dev --bun` no longer waves `.fn.mts` / `.fn.cts` / `.fn.mjs` / `.fn.cjs` into the browser.

The refusal that keeps a server function off the Bun dev pipeline matched a hand-written glob,
`**/*.fn.{ts,tsx,js,jsx}`, while both build pipelines stub anything matching
`/\.fn(\.[cm]?[jt]sx?)?$/`. So a `todos.fn.mts` was a server function everywhere except the one check
that exists to stop it leaking - it started the dev server and shipped the function bodies, and
whatever they close over, to the browser. Measured across all eight extensions, four leaked.

Both refusals now test against the same matchers the transforms use, exported as `SERVER_FN_MODULE`
and `SERVER_ONLY_MODULE` from `@nifrajs/web`. `SERVER_ONLY_MODULE` had two definitions and now has one
owner. A test drives every accepted extension through the guard, so widening a convention without
widening the guard fails there rather than in someone's browser.
