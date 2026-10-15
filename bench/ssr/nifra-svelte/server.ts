/**
 * nifra's render API in a server you write yourself, on Bun: a raw `Bun.serve` fetch handler. No
 * nifra router, createWebApp, file routes or loader - so not a framework app (bench/ssr/README.md).
 *
 *   bun run bench/ssr/nifra-svelte/build.ts && PORT=4322 bun bench/ssr/nifra-svelte/server-bun.js
 */
import { catalogHandler } from "./handler.ts"

const clientJs = await Bun.file(`${import.meta.dir}/dist/client.js`).text()

Bun.serve({
  port: Number(Bun.env.PORT ?? 4322),
  hostname: "127.0.0.1",
  fetch: catalogHandler(clientJs),
})
