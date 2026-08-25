/**
 * `@nifrajs/core` - Nifra's lean HTTP server API.
 *
 * Nifra 2.0 keeps the package root intentionally lean. Optional systems live at documented
 * subpaths so importing the root cannot activate unrelated runtimes.
 *
 * Every named export below is re-exported in a SINGLE hop from the module that defines it -
 * deliberately not `export * from "./server.ts"`. A root binding that travels through a chained
 * barrel can be dropped by a bundler that rewrites module loads (the single-copy plugin does
 * exactly that), which surfaces as a runtime `ReferenceError` only in bundled output. The list
 * must stay identical to `./server.ts`; `server-entry.test.ts` enforces the parity.
 */

/**
 * Current package version. A hardcoded literal on purpose - core runs on the edge (no fs), so it can't
 * read its own package.json at runtime. `scripts/version.ts` rewrites it on every release bump and
 * `check:publish` asserts it equals `@nifrajs/core`'s package version.
 */
export const VERSION = "3.3.0" as const

export type Version = typeof VERSION

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
