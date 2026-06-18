// Build the client bundle with Bun.build + Solid's (dom) transform via @nifrajs/web-solid.
import { solidBunPlugin } from "@nifrajs/web-solid"

const result = await Bun.build({
  entrypoints: [`${import.meta.dir}/client.ts`],
  outdir: `${import.meta.dir}/dist`,
  target: "browser",
  // "bun" resolves workspace @nifrajs packages to their src (fresh, no rebuild); "solid" +
  // "browser" give Solid's dom/hydrate build.
  conditions: ["bun", "solid", "browser"],
  plugins: [solidBunPlugin("dom")],
  naming: "client.js",
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
console.log("built", result.outputs.map((o) => o.path).join(", "))
