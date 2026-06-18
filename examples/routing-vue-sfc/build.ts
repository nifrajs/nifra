// Build the client bundle via @nifrajs/web/build: discover routes (.vue) → codegen → Bun.build,
// content-hashed + minified, writing dist/manifest.json (read by server.ts). vueBunPlugin("dom")
// compiles the .vue route components (+ the adapter's Router/Await) for the browser. The __VUE_*
// defines silence Vue's prod feature-flag warnings.
//   bun run examples/routing-vue-sfc/build.ts
import { buildClient } from "@nifrajs/web/build"
import { vueBunPlugin } from "@nifrajs/web-vue/plugin"

const manifest = await buildClient({
  routesDir: `${import.meta.dir}/routes`,
  outDir: `${import.meta.dir}/dist`,
  clientModule: "@nifrajs/web-vue/client",
  plugins: [vueBunPlugin("dom")],
  conditions: ["bun", "browser"],
  define: {
    "process.env.NODE_ENV": '"production"',
    __VUE_OPTIONS_API__: "true",
    __VUE_PROD_DEVTOOLS__: "false",
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
  },
})
console.log("built", manifest.entry)
