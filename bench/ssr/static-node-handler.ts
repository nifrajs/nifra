import { readFile } from "node:fs/promises"
import { extname } from "node:path"
import { staticFileFor } from "./static-path.ts"

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
}

/** Read per request, matching the Bun static target's disk-backed workload. */
export function createStaticFetch(dist: string): (request: Request) => Promise<Response> {
  return async (request) => {
    const path = staticFileFor(dist, new URL(request.url).pathname)
    if (path === undefined) return new Response("Not Found", { status: 404 })
    try {
      return new Response(await readFile(path), {
        headers: { "content-type": CONTENT_TYPES[extname(path)] ?? "application/octet-stream" },
      })
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EISDIR")
      ) {
        return new Response("Not Found", { status: 404 })
      }
      throw error
    }
  }
}
