# Native server component examples

Run any of the four applications from the repository root after `bun install` and `bun run build`:

```sh
bun examples/server-components/react/run.ts
bun examples/server-components/vue/run.ts
bun examples/server-components/svelte/run.ts
bun examples/server-components/solid/run.ts
```

Each opens http://127.0.0.1:3000. Add `build` to emit a coordinated production application; run its generated `.nifra-components-fixtures/examples/<adapter>/server.js` with Bun.

The examples share the applications exercised by the certification matrix in `packages/web/test/fixtures/server-components` and `packages/web-react/test/fixtures/server-components`. They demonstrate native state and focus preservation, nested ranges, slots, portals, router navigation, server-function refresh, account-scope invalidation and progressive forms. Their data and account scopes are fabricated. Fixed nonces, deliberately denied requests and sentinel fields belong to this test harness; production applications supply a fresh nonce and verified authorization at the data layer.

`bun run check:server-components:consumers` separately installs local package tarballs in a clean directory and runs the real `nifra build --target node` and `nifra dev` commands for all four applications. It rejects workspace source aliases.
