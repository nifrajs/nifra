/**
 * Elysia worst-case app on Node via its official adapter - identical app to the Bun
 * server (only `{ adapter: node() }` changes), run directly by Node (v24+ strips types).
 *
 *   node bench/http/worst-case/serve-node-elysia.ts <port>
 */
import { node } from "@elysiajs/node"
import { makeWorstElysiaApp } from "./_elysia-app.ts"

const port = Number(process.argv[2])
if (!Number.isInteger(port)) {
  throw new Error("usage: node bench/http/worst-case/serve-node-elysia.ts <port>")
}

makeWorstElysiaApp({ adapter: node() }).listen(port)
