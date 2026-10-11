import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

const root = resolve(process.argv[2])
const { default: handler } = await import(
  pathToFileURL(resolve(root, "functions/index.func/index.js"))
)
const build = JSON.parse(await readFile(resolve(root, "component-build.json"), "utf8"))
createServer(async (request, response) => {
  const path = new URL(request.url, "http://fixture.test").pathname
  if (build.assets.includes(path) && ["GET", "HEAD"].includes(request.method)) {
    const bytes = await readFile(resolve(root, "static", path.slice(1)))
    response.setHeader("Content-Type", path.endsWith(".css") ? "text/css" : "text/javascript")
    response.setHeader("Cache-Control", "public, max-age=31536000, immutable")
    response.end(request.method === "HEAD" ? undefined : bytes)
  } else await handler(request, response)
}).listen(Number(process.env.PORT), "127.0.0.1")
