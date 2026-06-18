const define = {
  "process.env.NODE_ENV": '"production"',
  __VUE_OPTIONS_API__: "true",
  __VUE_PROD_DEVTOOLS__: "false",
  __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
}

const client = await Bun.build({
  entrypoints: [`${import.meta.dir}/client.ts`],
  outdir: `${import.meta.dir}/dist`,
  target: "browser",
  conditions: ["bun", "browser"],
  naming: "client.js",
  minify: true,
  define,
})

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
