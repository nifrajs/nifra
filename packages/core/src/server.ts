/**
 * Lean server entry for the common Nifra runtime.
 *
 * Use `@nifrajs/core/server` or the equivalent lean package root when building an HTTP app.
 * Optional systems such as
 * causality, invariants, manifests, reflection, and capability tooling live at
 * their dedicated subpaths. Keeping this entry curated is intentional: do not
 * export an opt-in module here unless the Server implementation already loads it.
 */

export { FrameworkError, RouteConfigError, type RouteConfigErrorCode } from "./errors.ts"
export { FRAMEWORK_NAME, type FrameworkName } from "./internal/brand.ts"
export { METHODS, type Method, Router, type RouterMatch } from "./router/router.ts"
export type {
  InferInput,
  InferOutput,
  StandardIssue,
  StandardResult,
  StandardSchemaV1,
  StandardTypes,
  ValidationOutcome,
} from "./schema/standard.ts"
export type {
  Context,
  Params,
  Platform,
  Prettify,
  ResponseControls,
  RouteSchema,
} from "./server/context.ts"
export {
  type CookieOptions,
  parseCookies,
  serializeCookie,
  signValue,
  unsignValue,
} from "./server/cookies.ts"
export {
  commonSecretPatterns,
  jsonLogger,
  type LogFields,
  type Logger,
  type RedactOptions,
  redactLogFields,
  silentLogger,
} from "./server/logger.ts"
export type { Registry, RouteInfo } from "./server/registry.ts"
export {
  type AdmissionController,
  type AdmissionDecision,
  type AnyServer,
  type DurableObjectNamespaceLike,
  defineIdentityPlugin,
  definePlugin,
  defineRouterPlugin,
  type ExecutionContext,
  type Handler,
  type IdentityPlugin,
  type McpPromptDescriptor,
  type McpResourceDescriptor,
  type Middleware,
  type NifraPlugin,
  type NodeServeOutcome,
  type OnRequestResult,
  type PromptArgument,
  type PromptMessage,
  type ResponseFinalization,
  type RouteDescriptor,
  type RunningServer,
  type ScheduledController,
  type ScheduledHandler,
  Server,
  type ServerOptions,
  server,
  type ToolAnnotations,
  toFetchHandler,
} from "./server/server.ts"
export type {
  SSEContext,
  SSEInit,
  SSEMessage,
  SSEStream,
  TypedSSEStream,
} from "./server/sse.ts"
export type {
  NifraWebSocket,
  StandardWebSocket,
  WebSocketContext,
  WebSocketData,
  WebSocketHandler,
  WebSocketUpgradeOutcome,
} from "./server/websocket.ts"
