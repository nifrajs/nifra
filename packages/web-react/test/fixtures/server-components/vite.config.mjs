import { serverComponentsConfig } from "@nifrajs/web/server-components/build"
export default await serverComponentsConfig({
  root: import.meta.dirname,
  adapter: "react",
  port: 4421,
  entries: {
    rsc: "./entry-rsc.backend.tsx",
    ssr: "./entry-ssr.backend.ts",
    client: "./entry.client.ts",
  },
})
