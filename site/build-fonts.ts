/**
 * Self-host the site's three typefaces. Run once, by hand, when a family or a weight range changes:
 *
 *   bun run site/build-fonts.ts
 *
 * It downloads the latin variable `.woff2` of each family into `public/fonts/` (content-hashed) and
 * writes `data/fonts.json` - the `@font-face` stylesheet the root layout inlines plus the preload
 * links. Both outputs are committed, so a normal site build never touches the network.
 */
import { loadGoogleFont } from "@nifrajs/web/fonts"

const dir = import.meta.dir
const io = { outDir: `${dir}/public/fonts`, publicPath: "/assets/fonts" }

const families = [
  { family: "Space Grotesk", weights: ["300..700"], subsets: ["latin"] },
  { family: "Inter", weights: ["100..900"], subsets: ["latin"] },
  { family: "JetBrains Mono", weights: ["100..800"], subsets: ["latin"] },
] as const

const loaded = []
for (const family of families) loaded.push(await loadGoogleFont(family, io))

await Bun.write(
  `${dir}/data/fonts.json`,
  `${JSON.stringify(
    {
      css: loaded.map((font) => font.css).join("\n\n"),
      // Body + display are on every page above the fold; the mono face can arrive a beat later.
      preload: loaded.slice(0, 2).flatMap((font) => font.preloads.map((link) => link.href)),
    },
    null,
    2,
  )}\n`,
)

for (const font of loaded) {
  for (const asset of font.assets) {
    console.log(`${font.family}: ${asset.fileName} (${(asset.bytes.length / 1024).toFixed(1)} KB)`)
  }
}
