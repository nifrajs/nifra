---
"@nifrajs/web": minor
---

A Vite/Rollup production build carries the same client-leak guards as the Bun build.

Production stays Bun by default - it is faster and Bun-native, and that is what nifra competes on. But
some apps need a Vite-only transform with no Bun equivalent, and for those a Vite/Rollup production client
build is the escape hatch. The moment that hatch exists, the two client-leak guards have to come with it:
they are security guards, not lints - one stops secrets and database access shipping to a browser - and a
second production pipeline arriving without them, or with a "mostly ported" copy, is exactly the failure
the bundler-neutral module graph was introduced to prevent.

`@nifrajs/web/plugins/vite-leak-guard` is not a second implementation. It adapts Rollup's bundle into the
neutral `ClientModuleGraph` (`fromRollupBundle`) and runs the SAME `detectNodeBuiltinsInClient` /
`detectServerOnlyInClient` the Bun build runs, through the SAME failure messages - now extracted so both
pipelines share one owner. A `node:` builtin or a `server-only`-marked module reaching the client fails
the build identically whichever bundler produced it, including via dynamic `import()`.

One adapter subtlety is load-bearing: the guards locate a leak by finding the builtin inside a chunk's
module list. Bun bundles the `node:` polyfill, so it appears there; Rollup externalizes `node:`, so it
never would - the adapter synthesizes the builtin into the importing chunk so the neutral graph is
identical to Bun's. Proven with a real `vite build` that fails on a real leak (static and dynamic) and
passes clean code, alongside unit tests asserting the two adapters yield the same finding.

No behaviour change for existing Bun builds: the guard logic and messages are unchanged, only relocated
behind shared formatters.
