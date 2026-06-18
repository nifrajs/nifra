# cli-react — the nifra CLI, zero-config

This app has **no `dev.ts` / `build.ts` / `server.ts`** — just the three conventions the `nifra` CLI
reads:

- `routes/` — file-based routes.
- `framework.ts` — names the framework: `adapter`, `clientModule`, and `vitePlugins` (dev HMR). Vue /
  Svelte / Solid additionally export `clientPlugins` / `serverPlugins` (their Bun compile plugins) and
  Solid a `conditions: ["solid"]`; React/Preact need none.
- `backend.ts` — the typed contract (`export const backend`). Optional.

```sh
nifra dev      # true-HMR dev server (Vite middleware + nifra SSR) — edit components/Counter.tsx live
nifra build    # bundle the client (content-hashed) + write dist/manifest.json (incl. CSS)
nifra start    # serve the built client + SSR on Bun (assets + <link> stylesheets + matched-route preload)
```

`import "./app.css"` in `_layout.tsx` is bundled by `nifra build` and linked on every page by
`nifra start` (injected + HMR'd by `nifra dev`) — the CSS pipeline, through the CLI.
