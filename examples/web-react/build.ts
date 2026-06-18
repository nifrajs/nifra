// Build the client bundle with Bun.build. React's JSX is Bun-native — no plugin needed.
// `process.env.NODE_ENV` is defined so React's browser build doesn't reference `process`.
const result = await Bun.build({
  entrypoints: [`${import.meta.dir}/client.ts`],
  outdir: `${import.meta.dir}/dist`,
  target: "browser",
  // "bun" resolves workspace @nifrajs packages to their src (fresh, no rebuild).
  conditions: ["bun", "browser"],
  naming: "client.js",
  define: { "process.env.NODE_ENV": '"production"' },
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
console.log("built", result.outputs.map((o) => o.path).join(", "))
