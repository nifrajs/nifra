---
"@nifrajs/web": minor
"@nifrajs/cli": minor
---

The Bun dev server answers only loopback host names (`localhost`, `*.localhost`, `127.0.0.1`, `[::1]`) and refuses any other `Host` with 403. It already listened on 127.0.0.1 only, but answered any `Host`, so a page on another site whose name a DNS rebind pointed at 127.0.0.1 could read SSR pages, loader data and the error overlay. A name the server should answer under (a hosts-file entry, a tunnel) goes in the new `allowedHosts` option of `createDevServer`, or in `export const dev = { allowedHosts: [...] }` in `nifra.config.ts`.
