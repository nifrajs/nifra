# cli-react — the nifra CLI, zero-config

This app has **no `dev.ts` / `build.ts` / `server.ts`** — just the conventions the `nifra` CLI
reads:

- `routes/` — file-based routes.
- `framework.ts` — deploy-safe render adapter imported by generated server bundles.
- `nifra.config.ts` — CLI-only `clientModule` and Vite plugin (dev HMR). Compiler frameworks also put
  their `clientPlugins` / `serverPlugins` here.
- `backend.ts` — the typed contract (`export const backend`). Optional.

```sh
nifra dev      # true-HMR dev server (Vite middleware + nifra SSR) — edit components/Counter.tsx live
nifra build    # complete Bun deploy: dist/server.js + content-hashed dist/assets/ (incl. CSS)
nifra start    # run dist/server.js (assets + SSR + matched-route preload)
```

`import "./app.css"` in `_layout.tsx` is bundled by `nifra build` and linked on every page by
`nifra start` (injected + HMR'd by `nifra dev`) — the CSS pipeline, through the CLI.
