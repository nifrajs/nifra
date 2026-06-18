// Build the client hydration bundle with Bun.build. Vue uses render functions here, so no SFC
// compiler / build plugin is needed. The `__VUE_*` defines silence Vue's prod feature-flag warnings.
const result = await Bun.build({
  entrypoints: [`${import.meta.dir}/client.ts`],
  outdir: `${import.meta.dir}/dist`,
  target: "browser",
  conditions: ["bun", "browser"],
  naming: "client.js",
  minify: true,
  define: {
    "process.env.NODE_ENV": '"production"',
    __VUE_OPTIONS_API__: "true",
    __VUE_PROD_DEVTOOLS__: "false",
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
  },
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
console.log("built", result.outputs.map((o) => o.path).join(", "))
