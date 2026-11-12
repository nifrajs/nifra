/**
 * `@nifrajs/web/shell` - what a page needs when it ships inside a native shell (Tauri, Capacitor,
 * Electron) and its server lives on another origin. Kept apart from `@nifrajs/web/client` so an app
 * that is only a website carries none of it.
 */
export type { RouterFetch } from "./router.ts"
export {
  appFetch,
  routeDataTransport,
  type ServerFetch,
  type ServerFetchOptions,
  serverFetch,
} from "./server-fetch.ts"
