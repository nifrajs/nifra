/**
 * A plain nifra Node server - no proxy, no static - for the A/B that asks whether the Node-stream
 * hand-off costs the ORDINARY request path anything. `/get` returns a small JSON body; `/post`
 * reads a JSON body and echoes a field, which is the shape that exercises the request-body wrapper.
 */

import { server } from "@nifrajs/core"
import { serve } from "@nifrajs/node"

const port = Number(process.argv[2] ?? 3630)

const app = server()
  .get("/get", () => ({ ok: true, items: [1, 2, 3, 4, 5], name: "bench" }))
  .post("/post", async (c) => {
    const body = (await c.req.json()) as { readonly name?: string }
    return { ok: true, name: body.name ?? "" }
  })

await serve(app, { port, hostname: "0.0.0.0" })
