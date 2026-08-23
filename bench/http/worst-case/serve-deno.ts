/**
 * Worst-case benchmark server for the DENO section, selected by CLI arg. Identical apps
 * to the Bun/Node sections (see _app.ts / _elysia-app.ts).
 *
 *   deno run --allow-net --allow-env --no-check bench/http/worst-case/serve-deno.ts <nifra|elysia> <port>
 */
const framework = Deno.args[0]
const port = Number(Deno.args[1])

if (!Number.isInteger(port)) {
  throw new Error(
    "usage: deno run --allow-net --allow-env --no-check bench/http/worst-case/serve-deno.ts <nifra|elysia> <port>",
  )
}

if (framework === "nifra") {
  const { makeWorstNifraApp } = await import("./_app.ts")
  const { serve } = await import("../../../packages/deno/src/index.ts")
  await serve(makeWorstNifraApp(), { port })
} else if (framework === "elysia") {
  // Elysia on Deno via its Web-Standard adapter → Deno.serve(app.fetch), matching ../serve-deno.ts.
  const { WebStandardAdapter } = await import("elysia/adapter/web-standard")
  const { makeWorstElysiaApp } = await import("./_elysia-app.ts")
  Deno.serve({ port, onListen() {} }, makeWorstElysiaApp({ adapter: WebStandardAdapter }).fetch)
} else {
  throw new Error(`unknown framework: ${framework ?? "(none)"}`)
}
