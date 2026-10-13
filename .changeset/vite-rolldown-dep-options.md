---
"@nifrajs/web": patch
---

Under Vite 8, a framework plugin's `optimizeDeps.rollupOptions` no longer prints Vite's "`optimizeDeps.rollupOptions` ... is deprecated" warning on every `nifra dev` start and Vite build. `@vitejs/plugin-react@4.x` sets `optimizeDeps.rollupOptions.jsx`; nifra already dropped the `jsx` key, but left the empty `rollupOptions` behind, which Vite still warns about. The key is now removed when nothing is left in it, and any remaining options move to `optimizeDeps.rolldownOptions`, where Vite reads them anyway. `ssr.optimizeDeps` is handled the same way, and the Vite production build now applies this to `vitePlugins` too.
