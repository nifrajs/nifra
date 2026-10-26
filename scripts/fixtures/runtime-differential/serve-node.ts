/** The differential app on Node through `@nifrajs/node`. Prints `{"port":N}` once listening. */
import { serve, serveStatic } from "@nifrajs/node"
import { createDifferentialApp, staticMount } from "./app.ts"

const dir = process.argv[2]
if (dir === undefined) throw new Error("usage: serve-node.ts <public-dir>")
const app = createDifferentialApp({ staticFiles: serveStatic(staticMount(dir)) })
const running = await serve(app, { port: 0, hostname: "127.0.0.1" })
process.stdout.write(`${JSON.stringify({ port: running.port })}\n`)
