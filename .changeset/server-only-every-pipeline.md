---
"@nifrajs/web": minor
"@nifrajs/cli": minor
---

The `.server` convention now holds in every client pipeline, not just one.

A `*.server.ts` module is server-only: the client build empties it so its import subtree - `node:`
builtins, native modules, secrets - never reaches a browser. That was implemented once, as a
`Bun.build` plugin, so it held in exactly one of the four client paths. `nifra build` emptied the
module; `nifra dev` (Vite), a Vite production build, and `nifra dev --bun` all bundled it whole.

A guard that holds in one pipeline is worse than no guard, because the file NAME reads as protection
everywhere it appears.

- `@nifrajs/web/plugins/vite-server-only` empties the module for Vite, registered in both the dev
  server and the production build. A parity test asserts it emits bytes identical to the Bun plugin.
- `nifra dev --bun` refuses to start on an app containing one, naming the files - the same treatment
  `*.fn` already had, because Bun's dev bundler takes no plugins and cannot be fixed with one.

The three `nifra dev --bun` refusals (CSS Modules, `*.fn`, `*.server`) now have tests. Two of them
guard secrets, and none of them had one.
