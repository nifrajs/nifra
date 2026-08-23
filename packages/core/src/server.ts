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
export { isSameOriginRequest } from "./internal/same-origin.ts"
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
  type CookieSecret,
  cookieNamePrefix,
  parseCookies,
  serializeCookie,
  signValue,
  unsignValue,
} from "./server/cookies.ts"
export {
  type DurableObjectNamespaceLike,
  type ExecutionContext,
  type ScheduledController,
  type ScheduledHandler,
  toFetchHandler,
} from "./server/edge.ts"
export { isSameOriginPath, pathnameOf, type UrlParts, urlPartsOf } from "./server/http.ts"
export {
  commonSecretPatterns,
  jsonLogger,
  type LogFields,
  type Logger,
  type RedactOptions,
  redactLogFields,
  silentLogger,
} from "./server/logger.ts"
export {
  type FetchApp,
  type LambdaEvent,
  type LambdaHandler,
  type LambdaResponse,
  type LambdaV1Event,
  type LambdaV2Event,
  type NetlifyEvent,
  type NetlifyHandler,
  type PlatformResponse,
  toLambdaHandler,
  toNetlifyHandler,
  toVercelHandler,
  type VercelHandler,
} from "./server/platform-adapters.ts"
export type { Registry, ResponseMapFor, RouteInfo, RouteInfoFor } from "./server/registry.ts"
export {
  type PlainRender,
  type ResponseResult,
  type StatusResponse,
  status,
} from "./server/runtime-core.ts"
export {
  type AdmissionController,
  type AdmissionDecision,
  type AnyServer,
  type ContextPlugin,
  type DefinePluginResult,
  defineContextPlugin,
  defineIdentityPlugin,
  definePlugin,
  defineRouterPlugin,
  type Handler,
  type IdentityPlugin,
  type McpPromptDescriptor,
  type McpResourceDescriptor,
  type Middleware,
  type NifraFeatureVersion,
  type NifraPlugin,
  type NodeRequestContext,
  type NodeRequestHook,
  type NodeResponseContext,
  type NodeResponseHook,
  type NodeServeOutcome,
  type OnRequestResult,
  type PluginTypeCollapsed,
  type PromptArgument,
  type PromptMessage,
  type ResponseBodyHook,
  type ResponseBodyReplacement,
  type ResponseFinalization,
  type ResponseHeadersHook,
  type ResponseHeadersView,
  type RouteDescriptor,
  type RunningServer,
  Server,
  type ServerOptions,
  server,
  type ToolAnnotations,
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
