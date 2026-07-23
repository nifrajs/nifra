---
"@nifrajs/web": minor
"@nifrajs/cli": minor
---

The Vite dev pipeline now resolves SSR too, which removes the dual-React class of bug.

`nifra dev` served the client through Vite while resolving route modules for SSR through Bun - two
resolvers disagreeing about one specifier, inside one process. That is what made `resolve.dedupe`
govern only half the app: an app added a hand-written React alias in `nifra.config.ts`, and it still
crashed, because the alias reached Vite and SSR never asked Vite. The symptom named a React internal
(`resolveDispatcher().useState` is null), so the actual cause - two copies at different paths - was
hours of inference away.

`discoverRoutes` accepts a `load` option, and the Vite dev server passes `ssrLoadModule`. Both halves
now resolve through the same toolchain, so an alias, a `dedupe`, or a condition configured for the
client governs the server as well.

Two things follow from that and are removed rather than kept "just in case":

- **Bun's SFC plugins are no longer registered in `nifra dev`.** Vite compiles `.vue` / `.svelte` /
  Solid for SSR through the app's `vitePlugins`. Registering Bun's alongside was the intermix itself -
  two toolchains compiling one file, only one of them governed by Vite's resolution. `nifra start` and
  the build path keep theirs, which is correct: those are the Bun pipeline.
- **The `importQuery` cache-buster is gone from the Vite path.** It existed to defeat Bun's import
  cache; Vite re-evaluates changed modules itself. `discoverRoutes` ignores `importQuery` when `load`
  is supplied, because appending one would mint a new module id per request and defeat that.

The dev server still re-creates the app on change, now only so a hard reload picks up a route add or
remove - the manifest comes from a directory scan, which `ssrLoadModule` cannot invalidate.
