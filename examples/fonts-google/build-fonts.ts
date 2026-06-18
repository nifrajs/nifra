/**
 * Build-time font self-hosting — the `next/font/google` equivalent for nifra.
 *
 * Run this once as a prebuild step (it hits the network):
 *
 *   bun run examples/fonts-google/build-fonts.ts
 *
 * It downloads Inter from Google, content-hashes the `.woff2` files into `public/fonts/`, and writes a
 * self-hosted `@font-face` stylesheet to `app/fonts.css`. Your app imports `app/fonts.css` (nifra's CSS
 * pipeline bundles + content-hashes it) and serves `public/` statically. Nothing hotlinks Google at
 * runtime; filenames are immutable so you can cache them forever.
 */

import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { loadGoogleFont } from "@nifrajs/web/fonts"

const inter = await loadGoogleFont(
  {
    family: "Inter",
    weights: [400, 700],
    subsets: ["latin"],
    display: "swap",
    // Eliminate the fallback→web-font layout shift (metrics for Inter vs Arial fallback):
    sizeAdjust: "107%",
  },
  { outDir: "public/fonts", publicPath: "/fonts" },
)

// The generated @font-face stylesheet — import this from your app entry / root layout.
await mkdir(dirname("app/fonts.css"), { recursive: true })
await writeFile("app/fonts.css", `${inter.css}\n`)

console.log(`✓ self-hosted ${inter.family}: ${inter.assets.length} file(s)`)
for (const a of inter.assets) console.log(`  ${a.href}  (${a.bytes.byteLength} bytes)`)

// `inter.preloads` are ready to spread into a root layout's `meta.link`, e.g.:
//
//   import interPreloads from "./fonts.preloads.json" with { type: "json" }
//   export const meta = { link: interPreloads }
//
// Preloading the primary (latin 400) file removes a render-blocking round trip. Don't preload every
// weight/subset — that forces downloads the page may not need.
await writeFile("app/fonts.preloads.json", `${JSON.stringify(inter.preloads, null, 2)}\n`)
console.log(`✓ wrote app/fonts.css + app/fonts.preloads.json`)
