import { resolve } from "node:path"
import { devServerComponents } from "@nifrajs/web/server-components/build"
import preact from "@preact/preset-vite"
import { svelte } from "@sveltejs/vite-plugin-svelte"
import vue from "@vitejs/plugin-vue"
import solid from "vite-plugin-solid"

const adapter = process.env.NIFRA_COMPONENT_ADAPTER ?? "vue"
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
    : [
        adapter === "vue"
          ? vue()
          : adapter === "svelte"
            ? svelte()
            : adapter === "preact"
              ? preact()
              : solid({ ssr: true }),
      ]
const server = await devServerComponents({
  root,
  adapter,
  target: "node",
  port: Number(process.env.PORT ?? 4441),
  entries,
  plugins,
})
server.printUrls()
