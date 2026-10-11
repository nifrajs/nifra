import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { ViteDevServer } from "vite"
import type { ComponentPipelineOptions } from "./build.ts"

/** The native dev path serves the same factory and Fetch handler as production. */
export function installComponentDevHandler(
  server: ViteDevServer,
  options: ComponentPipelineOptions,
): void {
  if (options.adapter === "react") return // plugin-rsc owns the SSR request entry in React dev.
  server.middlewares.use(async (req, res, next) => {
    const path = req.url ?? "/"
    if (
      path.startsWith("/@") ||
      path.startsWith("/node_modules/") ||
      /\.(?:[cm]?[jt]sx?|vue|svelte|css)(?:\?|$)/.test(path)
    ) {
      next()
      return
    }
    const abort = new AbortController()
    const close = (): void => {
      if (!res.writableEnded) abort.abort()
    }
    res.on("close", close)
    try {
      const module = await server.ssrLoadModule(options.entries.ssr)
      if (typeof module.createApp !== "function")
        throw new Error(
          "[nifra/components] The SSR entry must export createApp(clientEntry, assets)",
        )
      const app = await module.createApp(`/${options.entries.client.replace(/^\.\//, "")}`, {
        styles: [],
      })
      if (typeof app?.fetch !== "function") throw new Error("component_contract")
      const headers = new Headers()
      for (let i = 0; i < req.rawHeaders.length; i += 2)
        headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!)
      const method = req.method ?? "GET"
      const init: RequestInit & { duplex?: "half" } = { method, headers, signal: abort.signal }
      if (!["GET", "HEAD"].includes(method)) {
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion lint/plugin/noChainedTypeAssertions: Node and Bun name the same WHATWG stream API differently; this zero-copy bridge preserves that ABI.
        init.body = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>
        init.duplex = "half"
      }
      const request = new Request(new URL(path, `http://${req.headers.host ?? "localhost"}`), init)
      const response: Response = await app.fetch(request)
      if (abort.signal.aborted || res.destroyed) {
        await response.body?.cancel()
        return
      }
      res.statusCode = response.status
      for (const [name, value] of response.headers)
        if (name !== "set-cookie") res.setHeader(name, value)
      const cookies = response.headers.getSetCookie()
      if (cookies.length > 0) res.setHeader("set-cookie", cookies)
      // The runtime stream implements Node's Web Streams API despite the distinct TS declarations.
      if (response.body !== null && method !== "HEAD")
        await pipeline(
          Readable.fromWeb(
            // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion lint/plugin/noChainedTypeAssertions: Node and Bun name the same WHATWG stream API differently; this bridge preserves the stream without copying or decoding.
            response.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>,
          ),
          res,
        )
      else res.end()
    } catch (error) {
      // A disconnected read has no response destination and must not broadcast a Vite error overlay.
      if (!abort.signal.aborted && !res.destroyed) next(error)
    } finally {
      res.off("close", close)
    }
  })
}
