/**
 * Serve a nifra app on Node's `http` server via the `@nifrajs/node` adapter — the same
 * `app` you'd `app.listen()` on Bun. Runs under Bun *or* Node (the adapter only uses
 * `node:http` + Web `Request`/`Response`).
 *
 *   bun run examples/serve-on-node.ts
 *   node --experimental-strip-types examples/serve-on-node.ts   # real Node
 */
import { server } from "@nifrajs/core/server"
import { serve } from "@nifrajs/node"

const app = server()
  .get("/", () => ({ ok: true }))
  .get("/users/:id", (c) => ({ id: c.params.id }))
  .post("/echo", (c) => c.req.json())

const node = await serve(app, { port: 0 })
const base = `http://localhost:${node.port}`
console.log(`listening on ${base}`)

const got = await (await fetch(`${base}/users/42`)).json()
const echoed = await (
  await fetch(`${base}/echo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hi: "there" }),
  })
).json()
console.log("GET /users/42 →", got) // { id: "42" }
console.log("POST /echo    →", echoed) // { hi: "there" }

await node.stop()
console.log("stopped")
