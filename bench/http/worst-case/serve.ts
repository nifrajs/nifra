/**
 * Worst-case benchmark server for the BUN section, selected by CLI arg. Both frameworks
 * serve the identical worst-case app (see _app.ts / _elysia-app.ts).
 *
 *   bun run bench/http/worst-case/serve.ts <nifra|elysia> <port>
 */
const framework = process.argv[2]
const port = Number(process.argv[3])

if (!Number.isInteger(port)) {
  throw new Error("usage: bun run bench/http/worst-case/serve.ts <nifra|elysia> <port>")
}

if (framework === "nifra") {
  const { makeWorstNifraApp } = await import("./_app.ts")
  makeWorstNifraApp().listen(port)
} else if (framework === "elysia") {
  const { makeWorstElysiaApp } = await import("./_elysia-app.ts")
  makeWorstElysiaApp().listen(port)
} else {
  throw new Error(`unknown framework: ${framework ?? "(none)"}`)
}

export {}
