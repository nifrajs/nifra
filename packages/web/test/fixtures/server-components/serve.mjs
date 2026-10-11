import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { resolve } from "node:path"

const adapter = process.env.NIFRA_COMPONENT_ADAPTER ?? "vue"
const root = resolve(import.meta.dirname, "dist", adapter)
const manifest = JSON.parse(await readFile(`${root}/client/.vite/manifest.json`, "utf8"))
const entry = Object.values(manifest).find((record) => record.isEntry)
const { createApp } = await import(`${root}/server/index.js`)
const app = createApp(`/${entry.file}`)
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1:4422")
    if (url.pathname.startsWith("/assets/")) {
      if (!/^\/assets\/[\w.-]+$/.test(url.pathname)) {
        res.writeHead(404)
        res.end()
        return
      }
      const content = await readFile(`${root}/client${url.pathname}`)
      res.writeHead(200, {
        "content-type": url.pathname.endsWith(".css") ? "text/css" : "text/javascript",
        "cache-control": "public, max-age=31536000, immutable",
      })
      res.end(content)
      return
    }
    const response = await app.fetch(new Request(url, { headers: new Headers(req.headers) }))
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(Buffer.from(await response.arrayBuffer()))
  } catch (error) {
    console.error(error)
    res.writeHead(500)
    res.end()
  }
})
server.listen(4422, "127.0.0.1", () => console.log(`${adapter} production fixture ready`))
