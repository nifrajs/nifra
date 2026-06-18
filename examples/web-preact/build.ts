// Build the client hydration bundle with Bun.build. Preact uses h() render functions here, so no
// JSX / build plugin is needed (contrast routing-solid's Babel preload). NODE_ENV=production trims
// Preact's dev-only warnings from the bundle.
const result = await Bun.build({
  entrypoints: [`${import.meta.dir}/client.ts`],
  outdir: `${import.meta.dir}/dist`,
  target: "browser",
  conditions: ["bun", "browser"],
  naming: "client.js",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
console.log("built", result.outputs.map((o) => o.path).join(", "))
