import { createRequire } from "node:module"
import { resolve } from "node:path"
import { buildServerComponents, devServerComponents } from "@nifrajs/web/server-components/build"

export async function runExample(adapter: "react" | "vue" | "svelte" | "solid" | "preact") {
  const repo = resolve(import.meta.dirname, "../..")
  const fixtures = resolve(repo, "packages/web/test/fixtures/server-components")
  const require = createRequire(resolve(repo, "packages/web/package.json"))
  const plugins =
    adapter === "react"
      ? []
      : adapter === "vue"
        ? [(await import(require.resolve("@vitejs/plugin-vue"))).default()]
        : adapter === "svelte"
          ? [(await import(require.resolve("@sveltejs/vite-plugin-svelte"))).svelte()]
          : adapter === "preact"
            ? [(await import(require.resolve("@preact/preset-vite"))).default()]
            : [(await import(require.resolve("vite-plugin-solid"))).default({ ssr: true })]
  const options = {
    root:
      adapter === "react"
        ? resolve(repo, "packages/web-react/test/fixtures/server-components")
        : resolve(fixtures, adapter),
    adapter,
    plugins,
    target: "bun" as const,
    entries:
      adapter === "react"
        ? { client: "entry.client.ts", ssr: "entry-ssr.backend.ts", rsc: "entry-rsc.backend.tsx" }
        : { client: "entry.client.ts", ssr: "entry.backend.ts" },
    port: 3000,
    outDir: resolve(repo, ".nifra-components-fixtures/examples", adapter),
  }
  if (process.argv.includes("build")) console.log(await buildServerComponents(options))
  else (await devServerComponents(options)).printUrls()
}
