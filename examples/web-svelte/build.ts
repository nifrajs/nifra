// Build the client hydration bundle with Bun.build. Svelte components compile from .svelte files, so
// this passes svelteBunPlugin("dom") (the client-generate compiler). NODE_ENV=production trims dev code.
//   bun run examples/web-svelte/build.ts
import { svelteBunPlugin } from "@nifrajs/web-svelte/plugin"

const result = await Bun.build({
  entrypoints: [`${import.meta.dir}/client.ts`],
  outdir: `${import.meta.dir}/dist`,
  target: "browser",
  conditions: ["bun", "browser"],
  plugins: [svelteBunPlugin("dom")],
  naming: "client.js",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
console.log("built", result.outputs.map((o) => o.path).join(", "))
