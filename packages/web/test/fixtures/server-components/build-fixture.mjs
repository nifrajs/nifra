import { resolve } from "node:path"
import { buildServerComponents } from "@nifrajs/web/server-components/build"
import { svelte } from "@sveltejs/vite-plugin-svelte"
import vue from "@vitejs/plugin-vue"
import preact from "@preact/preset-vite"
import solid from "vite-plugin-solid"

const adapter = process.env.NIFRA_COMPONENT_ADAPTER ?? "vue"
const target = process.env.NIFRA_COMPONENT_TARGET ?? "node"
const root =
  adapter === "react"
    ? resolve(import.meta.dirname, "../../../../web-react/test/fixtures/server-components")
    : resolve(import.meta.dirname, adapter)
const entries =
  adapter === "react"
    ? { client: "entry.client.ts", ssr: "entry-ssr.backend.ts", rsc: "entry-rsc.backend.tsx" }
    : { client: "entry.client.ts", ssr: "entry.backend.ts" }
const plugins =
  adapter === "react"
    ? []
    : [adapter === "vue" ? vue() : adapter === "svelte" ? svelte() : adapter === "preact" ? preact() : solid({ ssr: true })]
const outDir = resolve(
  import.meta.dirname,
  "../../../../../.nifra-components-fixtures",
  adapter,
  target,
)
console.log(
  JSON.stringify(await buildServerComponents({ root, adapter, target, outDir, entries, plugins })),
)
