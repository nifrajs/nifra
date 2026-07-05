---
"@nifrajs/web": patch
---

fix(web): silence the spurious `jsx` "Invalid key" warning at `nifra dev` boot under rolldown-vite

`@vitejs/plugin-react`'s `react()` returns an ARRAY of plugins, and `nifra.config.ts` lists it as
`vitePlugins = [react()]`, so the plugin list reaches nifra NESTED (`[[babel, refresh]]`).
`normalizeRolldownPlugins` — which strips the stale `optimizeDeps.rollupOptions.jsx` key that Vite 8's
rolldown dep-optimizer rejects — mapped over the outer array without flattening, so it never reached the
inner `vite:react-babel` plugin that emits the key, and Vite (which flattens plugin arrays itself) then ran
the un-stripped hook. It now flattens first, so the strip reaches every plugin and the harmless-but-noisy
`Warning: Invalid input options … "jsx" Invalid key: Expected never but received "jsx"` is gone. No
behavior change — JSX transform, HMR, and Fast Refresh are unaffected.
