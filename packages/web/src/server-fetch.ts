import { type FetchRouteData, fetchRouteData, type RouterFetch } from "./router.ts"

export interface ServerFetchOptions {
  /** The server's origin, for example `https://api.example.com`. */
  readonly origin: string
  /** Headers added to every request, or a function that returns them, such as a bearer token that
   * refreshes. They replace a request's own header of the same name. */
  readonly headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>)
  /** Sent as the request's `credentials`. Left out, the request's own value applies, which sends no
   * cookie to another origin. */
  readonly credentials?: RequestCredentials
  /** The `fetch` the requests go out through, such as a native shell's own HTTP client. */
  readonly fetch?: RouterFetch
}

/** A router `fetch` that also names the origin it sends to, which the live socket needs. */
export type ServerFetch = RouterFetch & { readonly origin: string }

/**
 * A router `fetch` for an app whose pages ship inside a native shell and whose server lives
 * elsewhere. A path-absolute URL (`/todos`) is sent to `origin`; anything else is sent as written.
 * Pass it as `createClientRouter({ fetch })`, or build with it as the `transport` module.
 */
export function serverFetch(options: ServerFetchOptions): ServerFetch {
  const origin = options.origin.endsWith("/") ? options.origin.slice(0, -1) : options.origin
  const send: RouterFetch = options.fetch ?? ((input, init) => fetch(input, init))
  const extra = options.headers
  const go: RouterFetch = async (input, init) => {
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
