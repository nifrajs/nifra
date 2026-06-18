const define = { "process.env.NODE_ENV": '"production"' }

// Build the client hydration bundle (the JS payload the SSR page ships) with Bun.build.
// React's JSX is Bun-native — no plugin. NODE_ENV=production so React ships its prod build.
const client = await Bun.build({
  entrypoints: [`${import.meta.dir}/client.ts`],
  outdir: `${import.meta.dir}/dist`,
  target: "browser",
  conditions: ["bun", "browser"], // resolve workspace @nifrajs packages to src
  naming: "client.js",
  minify: true,
  define,
})

// Build the Bun server too. Serving source TS (`bun run server.ts`) is convenient, but it measures
// a different artifact than the Node row (which is bundled+minified). Keep the Bun row production-like.
const server = await Bun.build({
  entrypoints: [`${import.meta.dir}/server.ts`],
  outdir: import.meta.dir,
  target: "bun",
  conditions: ["bun"],
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
