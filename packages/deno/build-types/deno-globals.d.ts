/**
 * Build-only ambient declarations for the slice of the `Deno` global this adapter touches.
 *
 * `tsc` has no Deno lib, and the root program excludes this package for exactly that reason -
 * but the published tarball needs emitted `dist/*.js` + `.d.ts`, because Deno refuses to strip
 * types for any file under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), which
 * includes its own npm cache. So the build needs *some* declaration of these globals.
 *
 * This file is NOT the typecheck authority and is never shipped: `bun run test:deno` runs
 * `deno check src/index.ts` against Deno's real lib, so a drift between this shim and the runtime
 * fails there. Keep it minimal - only what `src/index.ts` actually calls - so there is little to
 * drift. Nothing here appears in the emitted `.d.ts`: the public surface (`serve`, `ServeOptions`,
 * `DenoServer`, `FetchHandler`) references no `Deno.*` type.
 */
declare namespace Deno {
  /** A resolved TCP/UDP address - `server.addr` and the `onListen` argument. */
  interface NetAddr {
    readonly transport: "tcp" | "udp"
    readonly hostname: string
    readonly port: number
  }

  /** Per-request connection info Deno passes as the handler's second argument. */
  interface ServeHandlerInfo {
    readonly remoteAddr: NetAddr
  }

  interface ServeOptions {
    readonly port?: number | undefined
    readonly hostname?: string | undefined
    /** Aborting force-closes the server (drops in-flight requests). */
    readonly signal?: AbortSignal | undefined
    readonly onListen?: ((addr: NetAddr) => void) | undefined
  }

  interface HttpServer {
    /** Populated synchronously by `Deno.serve` - the bound address (`port: 0` resolved). */
    readonly addr: NetAddr
    /** Resolves once the server has fully shut down. */
    readonly finished: Promise<void>
    /** Stop accepting connections and drain in-flight requests. */
    shutdown(): Promise<void>
  }

  function serve(
    options: ServeOptions,
    handler: (request: Request, info: ServeHandlerInfo) => Response | Promise<Response>,
  ): HttpServer

  function upgradeWebSocket(request: Request): { socket: WebSocket; response: Response }

  function addSignalListener(signal: string, handler: () => void): void
  function removeSignalListener(signal: string, handler: () => void): void
}

/**
 * Deno's `WebSocket.send` takes any `ArrayBufferView`; `@types/bun` (this program's ambient lib)
 * narrows the buffer to a non-shared `ArrayBuffer`, which rejects the mirrored `NifraWs.send`
 * signature that Deno itself accepts. Merge the wider overload back in so the emit matches the
 * runtime rather than Bun's lib. Declaration-only - it never reaches `dist/`.
 */
interface WebSocket {
  send(data: string | ArrayBufferView | ArrayBuffer): void
}
