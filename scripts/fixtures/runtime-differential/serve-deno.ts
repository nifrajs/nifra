/** The differential app on Deno through `@nifrajs/deno`. Prints `{"port":N}` once listening. */
import { serve, serveStatic } from "@nifrajs/deno"
import { createDifferentialApp, staticMount } from "./app.ts"

const dir = Deno.args[0]
if (dir === undefined) throw new Error("usage: serve-deno.ts <public-dir>")
const app = createDifferentialApp({ staticFiles: serveStatic(staticMount(dir)) })
const running = await serve(app, { port: 0, hostname: "127.0.0.1" })
await Deno.stdout.write(new TextEncoder().encode(`${JSON.stringify({ port: running.port })}\n`))
