import type * as UWS from "uWebSockets.js"
import { createRequire } from "node:module"

export type Uws = typeof UWS
export type AppOptions = UWS.AppOptions
export type HttpRequest = UWS.HttpRequest
export type HttpResponse = UWS.HttpResponse
export type ListenSocket = UWS.us_listen_socket

let loaded: Uws | undefined

/**
 * uWebSockets.js is not on npm, so it is installed from GitHub and loaded here, on first use.
 * `createRequire` rather than `import`: its ESM wrapper (as of 20.71.0) imports an `index.js` the
 * release does not contain, while the CommonJS entry loads.
 */
export function loadUws(): Uws {
  if (loaded !== undefined) return loaded
  try {
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: `require` is untyped; the module is the one `Uws` describes
    loaded = createRequire(import.meta.url)("uWebSockets.js") as Uws
  } catch (cause) {
    throw new Error(
      "@nifrajs/node-uws: cannot load uWebSockets.js. It is not published to npm; install it from " +
        "GitHub: npm install uNetworking/uWebSockets.js#v20.71.0. Prebuilt binaries cover Node 22, " +
        "24 and 26 on macOS and Linux (x64, arm64) and Windows (x64); Alpine (musl) has none.",
      { cause },
    )
  }
  return loaded
}
