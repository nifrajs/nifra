import { svelteBunPlugin } from "@nifrajs/web-svelte/plugin"

const define = { "process.env.NODE_ENV": '"production"' }

const client = await Bun.build({
  entrypoints: [`${import.meta.dir}/client.ts`],
  outdir: `${import.meta.dir}/dist`,
  target: "browser",
  conditions: ["bun", "browser"],
  plugins: [svelteBunPlugin("dom")],
  naming: "client.js",
  minify: true,
  define,
})

const server = await Bun.build({
  entrypoints: [`${import.meta.dir}/server.ts`],
  outdir: import.meta.dir,
  target: "bun",
  conditions: ["bun", "svelte"],
  plugins: [svelteBunPlugin("ssr")],
  naming: "server-bun.js",
  minify: true,
  define,
})

for (const result of [client, server]) {
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
}
console.log("built", [...client.outputs, ...server.outputs].map((o) => o.path).join(", "))
