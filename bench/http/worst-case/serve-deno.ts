/**
 * Worst-case benchmark server for the DENO section, selected by CLI arg. Identical apps
 * to the Bun/Node sections (see _app.ts / _elysia-app.ts).
 *
 *   deno run --allow-net --allow-env --no-check bench/http/worst-case/serve-deno.ts <nifra|elysia> <port>
 */
const framework = Deno.args[0]
const port = Number(Deno.args[1])

import { serveFetch } from "../deno-ingress.ts"

if (!Number.isInteger(port)) {
  throw new Error(
    "usage: deno run --allow-net --allow-env --no-check bench/http/worst-case/serve-deno.ts <nifra|elysia> <port>",
  )
}

if (framework === "nifra") {
  const { makeWorstNifraApp } = await import("./_app.ts")
  const app = makeWorstNifraApp()
  serveFetch(app.fetch.bind(app), port)
} else if (framework === "elysia") {
  // Elysia on Deno via its Web-Standard adapter and the same Deno.serve wrapper as nifra.
  const { WebStandardAdapter } = await import("elysia/adapter/web-standard")
  const { makeWorstElysiaApp } = await import("./_elysia-app.ts")
  const app = makeWorstElysiaApp({ adapter: WebStandardAdapter })
  serveFetch(app.fetch.bind(app), port)
} else {
  throw new Error(`unknown framework: ${framework ?? "(none)"}`)
}
