import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { buildRpcServer, parseArgs } from "./launch.ts"

const options = parseArgs(Bun.argv.slice(2))
const rpc = await buildRpcServer(options)
const rpcHandle = await rpc.start()

// Assets ship from dist/public so the same origin serves the built browser bundle in dev and prod.
// packageRoot resolves to the workbench package whether this module runs from src/ or the built dist/.
const packageRoot = join(import.meta.dir, "..")
const htmlPath = join(packageRoot, "dist/public/index.html")
const scriptPath = join(packageRoot, "dist/public/app.js")

const ui = Bun.serve({
  hostname: "127.0.0.1",
  port: options.uiPort,
  fetch: async (request) => {
    const path = new URL(request.url).pathname
    if (path === "/app.js")
      return new Response(await readFile(scriptPath), {
        headers: securityHeaders("text/javascript; charset=utf-8"),
      })
    if (path === "/" || path === "/index.html")
      return new Response(await readFile(htmlPath), {
        headers: securityHeaders("text/html; charset=utf-8"),
      })
    return new Response("Not found", { status: 404 })
  },
})
// Bootstrap credentials live in the URL fragment. Browsers do not send fragments in HTTP
// requests, so the bearer token cannot enter the UI server's access logs or Referer headers.
const workbenchUrl = `${ui.url.toString().replace(/\/$/, "")}/#rpc=${encodeURIComponent(rpcHandle.url)}&token=${encodeURIComponent(rpcHandle.token)}`
console.log(`Nifra Workbench: ${workbenchUrl}`)
console.log(`Project: ${options.cwd}`)
console.log(`Backend: ${options.backend}`)

const stop = async (code: number): Promise<void> => {
  ui.stop(true)
  await rpc.stop()
  process.exit(code)
}
process.once("SIGINT", () => void stop(130))
process.once("SIGTERM", () => void stop(143))
await new Promise<void>(() => {})

function securityHeaders(contentType: string): Headers {
  return new Headers({
    "content-type": contentType,
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'self'; connect-src http://127.0.0.1:* http://localhost:*; script-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  })
}
