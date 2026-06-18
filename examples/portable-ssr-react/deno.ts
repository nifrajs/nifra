import { serve } from "@nifrajs/deno"
import { app } from "./app"

// Deno's runtime APIs (this entry runs under `deno run` and on Deno Deploy, which is the same runtime).
declare const Deno: {
  readFile(path: string): Promise<Uint8Array>
  env: { get(key: string): string | undefined }
}

// Serve /assets/* from disk (Deno Deploy serves deployed files via the same Deno.readFile).
const ASSETS = Deno.env.get("NIFRA_ASSETS_DIR") ?? "public/assets"
app.get("/assets/*", async (c) => {
  const name = new URL(c.req.url).pathname.slice("/assets/".length)
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return new Response("Bad Request", { status: 400 })
  try {
    const body = await Deno.readFile(`${ASSETS}/${name}`)
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

const deno = await serve(app, { port: Number(Deno.env.get("PORT") ?? 8501) })
console.log(`deno: http://localhost:${deno.port}`)
