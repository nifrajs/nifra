import { serverComponentsConfig } from "@nifrajs/web/server-components/build"
import preact from "@preact/preset-vite"
import { svelte } from "@sveltejs/vite-plugin-svelte"
import vue from "@vitejs/plugin-vue"
import solid from "vite-plugin-solid"

const adapter = process.env.NIFRA_COMPONENT_ADAPTER ?? "vue"
export default await serverComponentsConfig({
  root: `${import.meta.dirname}/${adapter}`,
  adapter,
  outDir: `../dist/${adapter}`,
  port: 4422,
  entries: { client: "./entry.client.ts", ssr: "./entry.backend.ts" },
  plugins: [
    adapter === "vue"
      ? vue()
      : adapter === "svelte"
        ? svelte()
        : adapter === "preact"
          ? preact()
          : solid({ ssr: true }),
    {
      name: "fixture-server",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (
            req.url.startsWith("/@") ||
            req.url.includes(".") ||
            req.url.startsWith("/node_modules")
          )
            return next()
          try {
            const { default: app } = await server.ssrLoadModule("./entry.backend.ts")
            const response = await app.fetch(
              new Request(`http://127.0.0.1:4422${req.url}`, { headers: new Headers(req.headers) }),
            )
            res.writeHead(response.status, Object.fromEntries(response.headers))
            res.end(Buffer.from(await response.arrayBuffer()))
          } catch (error) {
            next(error)
          }
        })
      },
    },
  ],
})
