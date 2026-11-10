import { type FetchRouteData, fetchRouteData, type RouterFetch } from "./router.ts"

export interface ServerFetchOptions {
  /** The server's origin, for example `https://api.example.com`. */
  readonly origin: string
  /** Headers added to every request to the server's origin, or a function that returns them, such as a
   * bearer token that refreshes. They replace a request's own header of the same name. A request to any
   * other origin goes out as written, without them. */
  readonly headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>)
  /** Sent as the `credentials` of every request to the server's origin. Left out, the request's own
   * value applies, which sends no cookie to another origin. For a cookie session use `"include"`, and the
   * server needs `credentials: true` in its CORS options and cookies a cross-site context may send
   * (`SameSite=None; Secure`); a web view may restrict them further. */
  readonly credentials?: RequestCredentials
  /** The `fetch` the requests go out through, such as a native shell's own HTTP client. */
  readonly fetch?: RouterFetch
}

/** A router `fetch` that also names the origin it sends to, which the live socket needs. */
export type ServerFetch = RouterFetch & { readonly origin: string }

/**
 * A router `fetch` for an app whose pages ship inside a native shell and whose server lives
 * elsewhere. A path-absolute URL (`/todos`) is sent to `origin`, with the headers and credentials; a
 * URL on `origin` gets them too, and any other URL is sent as written without them, so a call to a third
 * party never carries the server's bearer token. Pass it as `createClientRouter({ fetch })`, or build with it as the `transport` module.
 */
export function serverFetch(options: ServerFetchOptions): ServerFetch {
  const origin = options.origin.endsWith("/") ? options.origin.slice(0, -1) : options.origin
  const send: RouterFetch = options.fetch ?? ((input, init) => fetch(input, init))
  const extra = options.headers
  const onOrigin = (input: string): boolean =>
    input.charCodeAt(0) === 47 /* / */ ||
    input === origin ||
    input.startsWith(`${origin}/`) ||
    input.startsWith(`${origin}?`)
  const go: RouterFetch = async (input, init) => {
    if (!onOrigin(input)) return send(input, init)
    const headers = new Headers(init?.headers)
    const added = typeof extra === "function" ? await extra() : extra
    if (added !== undefined) {
      new Headers(added).forEach((value, name) => {
        headers.set(name, value)
      })
    }
    return send(input.charCodeAt(0) === 47 /* / */ ? origin + input : input, {
      ...init,
      headers,
      ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
    })
  }
  return Object.assign(go, { origin })
}

// Where a build with a `transport` puts it: a global slot, read by `appFetch` and by the stubs that
// stand in for server functions, so none of them import the transport or each other.
const SLOT = Symbol.for("nifra.fetch")

/**
 * The `fetch` an app's own requests to its server should use: the build's `transport` when it has
 * one, the global `fetch` otherwise. Hand it to `useQuery`'s fetcher or to the typed client
 * (`client(url, { fetch: appFetch })`) and the same code runs in a browser and in a native shell.
 */
export const appFetch: RouterFetch = (input, init) => {
  const send: unknown = Reflect.get(globalThis, SLOT)
  return isRouterFetch(send) ? send(input, init) : fetch(input, init)
}

const isRouterFetch = (value: unknown): value is RouterFetch => typeof value === "function"

/**
 * The router's own route-data transport, over `send`: for a layer that wraps the data fetch (keep-alive
 * in a build with a `transport`) and has to leave the request going where the router would send it.
 */
export const routeDataTransport =
  (send: RouterFetch): FetchRouteData =>
  (path, match, signal, navigation, purpose, hosts, read) =>
    fetchRouteData(path, match, signal, navigation, purpose, hosts, read, send)
