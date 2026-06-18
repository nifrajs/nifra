import { readFile } from "node:fs/promises"
import { serve } from "@nifrajs/node"
import { app } from "./app"

// Node has no platform asset layer, so the server serves /assets/* from disk (hashed → immutable).
const ASSETS = process.env.NIFRA_ASSETS_DIR ?? "public/assets"
app.get("/assets/*", async (c) => {
  const name = new URL(c.req.url).pathname.slice("/assets/".length)
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return new Response("Bad Request", { status: 400 })
  try {
    const body = await readFile(`${ASSETS}/${name}`)
    return new Response(body, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "public, max-age=31536000, immutable",
      },
    })
  } catch {
    return new Response("Not Found", { status: 404 })
  }
})

const node = await serve(app, { port: Number(process.env.PORT ?? 8500) })
console.log(`node: http://localhost:${node.port}`)
