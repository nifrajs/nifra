# cli-vue — the nifra CLI with a compiler framework

The `nifra` CLI running a **Vue SFC** app, zero-config. Like `cli-react`, there's no
`dev.ts`/`build.ts`/`server.ts` — but Vue (like Svelte/Solid) needs an SFC compiler, which is where
this example shows the **`framework.ts` / `nifra.config.ts` split**:

- **`framework.ts`** — just `export const adapter`. In a multi-target app this file is imported by the
  edge/server entries, so it must stay edge-bundlable: **no Vite plugin or SFC-compiler imports**.
- **`nifra.config.ts`** — the CLI's build/dev tooling: `adapter` (re-exported), `clientModule`,
  `vitePlugins` (`@vitejs/plugin-vue` — dev HMR), `clientPlugins`/`serverPlugins` (`vueBunPlugin` —
  the Bun-side SFC compile for `nifra build`/`start`/`dev`'s SSR), and Vue's `define` flags. This file
  is imported **only by the CLI** (which runs on Bun), so its compiler imports never reach a
  `target:"browser"` worker bundle. The CLI prefers `nifra.config.ts`, falling back to `framework.ts`.
- **`backend.ts`** — the typed contract (`export const backend`). Optional.

```sh
nifra dev      # true-HMR dev server: Vite compiles/HMRs the .vue client; nifra SSRs via vueBunPlugin("ssr")
nifra build    # bundle the client (.vue compiled by vueBunPlugin("dom")) + write dist/manifest.json
nifra start    # serve the built client + SSR on Bun (registers vueBunPlugin("ssr") for runtime .vue import)
```

React/Preact need none of the plugin fields (JSX is Bun-native) — see `cli-react`, which keeps
everything in a single `framework.ts`.
