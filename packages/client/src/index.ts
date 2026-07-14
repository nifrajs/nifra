/**
 * @nifrajs/client — browser-safe, end-to-end-typed client for @nifrajs/core servers.
 *
 * `client<typeof app>(url)` returns an Eden-style proxy whose calls are typed
 * from the server's accumulated route registry, with zero codegen.
 */
export {
  type ClientOptions,
  client,
  type FetchFn,
  type InProcessClient,
  inProcessClient,
  testClient,
} from "./client.ts"
export type { Jsonify } from "./jsonify.ts"
export type { ApiError, Result } from "./result.ts"
export type { ActionArgs, ActionData, ApiProxy, LoaderArgs, LoaderData } from "./routes.ts"
export type {
  RegistryOf,
  SubscribeOptions,
  Subscription,
  Treaty,
  TreatyFromRegistry,
} from "./treaty.ts"
