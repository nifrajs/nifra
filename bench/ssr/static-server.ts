/**
 * Minimal static-file server for the prerendered-TTFB benchmark: serves a built SSG `dist/` the way a
 * CDN would - `/` → `dist/index.html`, any other path → the file under `dist` (or 404). This is the
 * "served a prerendered file" side of the SSG-vs-SSR comparison (see prerender-ttfb.ts).
 *   DIST=examples/routing-react/dist PORT=4400 bun run bench/ssr/static-server.ts
 */
import { staticFileFor } from "./static-path.ts"

const dist = Bun.env.DIST
if (dist === undefined) throw new Error("set DIST to the built SSG output directory")
const port = Number(Bun.env.PORT ?? 4400)

const server = Bun.serve({
  port,
  fetch: async (req) => {
    const path = staticFileFor(dist, new URL(req.url).pathname)
    if (path === undefined) return new Response("Not Found", { status: 404 })
    const file = Bun.file(path)
    if (!(await file.exists())) return new Response("Not Found", { status: 404 })
    return new Response(file)
  },
})
console.log(`static http://localhost:${server.port} (DIST=${dist})`)
