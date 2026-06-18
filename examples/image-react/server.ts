/**
 * Image demo — a CLS-safe responsive <Image> with two backends: a stand-in "image CDN" that serves
 * labeled SVGs (so you can see which srcSet candidate the browser picked), and nifra's real self-hosted
 * resize endpoint (`@nifrajs/image/server`, Bun.Image) at `/_image`, which downsizes a real PNG.
 *   bun run examples/image-react/build.ts
 *   bun examples/image-react/server.ts        # http://localhost:3000
 */
import { createImageHandler } from "@nifrajs/image/server"
import { createWebApp } from "@nifrajs/web"
import type { BuildManifest } from "@nifrajs/web/build"
import { discoverRoutes } from "@nifrajs/web/fs"
import { reactAdapter } from "@nifrajs/web-react"

const publicDir = `${import.meta.dir}/public`
const assets = JSON.parse(
  await Bun.file(`${publicDir}/assets/manifest.json`)
    .text()
    .catch(() => '{"entry":"/assets/missing.js","assets":[],"routes":{}}'),
) as BuildManifest

const app = createWebApp({
  adapter: reactAdapter,
  manifest: discoverRoutes(`${import.meta.dir}/routes`),
  clientEntry: assets.entry,
  routePreload: assets.routes,
  title: "nifra — image demo",
})

// nifra's real self-hosted resize endpoint: decodes + downsizes `public/photo.png` with Bun.Image.
// `root` scopes local sources to ./public (path-traversal + symlink guarded); no `allowedOrigins`, so
// remote sources are refused. `selfHostedLoader({ endpoint: "/_image" })` (see routes/index.tsx) builds
// the `/_image?src=…&w=…` URLs the browser requests.
const image = createImageHandler({ root: publicDir })
app.get("/_image", (c) => image(c.req))

const escapeXml = (s: string): string => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`)

/**
 * Stand-in "image CDN": returns an SVG sized + labeled by the validated `?w=` query param, so the
 * browser visibly shows which `srcSet` candidate it selected (by device-pixel-ratio / viewport). A real
 * deployment points the loader at an actual CDN (Cloudflare Images, etc.) — nifra bundles no codec.
 */
app.get("/img/*", (c) => {
  const url = new URL(c.req.url)
  // Validate at the trust boundary: `w` is untrusted input. Require an integer in 1..4000, else 400.
  const wRaw = url.searchParams.get("w")
  const w = wRaw === null ? Number.NaN : Number(wRaw)
  if (!Number.isInteger(w) || w < 1 || w > 4000) {
    return new Response("invalid width", { status: 400 })
  }
  const h = Math.round((w * 9) / 16) // keep the 16:9 intrinsic aspect for every candidate
  const name = escapeXml(decodeURIComponent(url.pathname.slice("/img/".length)) || "image")
  const hue = ([...name].reduce((a, ch) => a + ch.charCodeAt(0), 0) * 37) % 360
  // One template literal (newlines are insignificant in SVG markup).
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img">
<rect width="100%" height="100%" fill="hsl(${hue} 65% 55%)"/>
<text x="50%" y="46%" fill="#fff" font-family="system-ui, sans-serif" font-size="${Math.round(w / 12)}" text-anchor="middle" font-weight="700">${escapeXml(name)}</text>
<text x="50%" y="62%" fill="#fff" font-family="system-ui, sans-serif" font-size="${Math.round(w / 18)}" text-anchor="middle" opacity="0.85">${w}×${h}</text>
</svg>`
  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=60",
    },
  })
})

app.get("/assets/*", async (c) => {
  const file = Bun.file(`${publicDir}${new URL(c.req.url).pathname}`)
  if (!(await file.exists())) return new Response("Not Found", { status: 404 })
  return new Response(file, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=31536000, immutable",
    },
  })
})

if (import.meta.main) {
  const running = app.listen(Number(Bun.env.PORT ?? 3000))
  console.log(`http://localhost:${running.port}`)
}
