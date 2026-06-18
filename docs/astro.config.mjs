// @ts-check
import starlight from "@astrojs/starlight"
import { defineConfig } from "astro/config"

// https://starlight.astro.build/reference/configuration/
export default defineConfig({
  integrations: [
    starlight({
      title: "nifra",
      description: "A Bun-native, contract-first TypeScript web framework.",
      sidebar: [
        {
          label: "Start here",
          items: [
            { label: "Getting started", slug: "getting-started" },
            { label: "vs. other frameworks", slug: "comparison" },
          ],
        },
        {
          label: "Guides",
          items: [
            { label: "Server & routing", slug: "guides/server" },
            { label: "Validation & OpenAPI", slug: "guides/validation" },
            { label: "Contracts & the client", slug: "guides/contracts" },
            { label: "Middleware & hardening", slug: "guides/middleware" },
            { label: "Plugins & extensibility", slug: "guides/plugins" },
            { label: "WebSockets", slug: "guides/websockets" },
            { label: "Runtimes & deployment", slug: "guides/runtimes" },
          ],
        },
      ],
    }),
  ],
})
