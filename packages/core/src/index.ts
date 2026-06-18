/**
 * @nifrajs/core — Bun-native, contract-first HTTP framework.
 *
 * The router is the perf-critical heart; the server and inline API are built on
 * the unified route descriptor.
 */

/** Current package version. Kept as a literal so type-level tests can pin it. */
export const VERSION = "0.0.0" as const

export type Version = typeof VERSION

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
export { validateStandard } from "./schema/standard.ts"
export {
  type RobotsOptions,
  type RobotsRule,
  robots,
  type SitemapChangeFreq,
  type SitemapEntry,
  type SitemapOptions,
  sitemap,
} from "./seo.ts"
export type {
  Context,
  Params,
  Platform,
  Prettify,
  ResponseControls,
  RouteSchema,
} from "./server/context.ts"
export {
  type ContextForOp,
  type ContractShape,
  defineContract,
  type HandlersFor,
  implement,
  type OperationDef,
  type RegistryFor,
  type RegistryFromImpl,
  type ResponseDef,
} from "./server/contract.ts"
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
  type AnyServer,
  type DurableObjectNamespaceLike,
  defineIdentityPlugin,
  definePlugin,
  type ExecutionContext,
  type Handler,
  type IdentityPlugin,
  type Middleware,
  type NifraPlugin,
  type NodeServeOutcome,
  type OnRequestResult,
  type RouteDescriptor,
  type RunningServer,
  type ScheduledController,
  type ScheduledHandler,
  Server,
  type ServerOptions,
  server,
  toFetchHandler,
} from "./server/server.ts"
export {
  type SSEContext,
  type SSEInit,
  type SSEMessage,
  type SSEStream,
  sse,
} from "./server/sse.ts"
export {
  type SignatureEncoding,
  type VerifyWebhookOptions,
  verifyWebhook,
  type WebhookFailureReason,
  type WebhookProvider,
  type WebhookResult,
} from "./server/webhook.ts"
export type {
  NifraWebSocket,
  StandardWebSocket,
  WebSocketContext,
  WebSocketData,
  WebSocketHandler,
  WebSocketUpgradeOutcome,
} from "./server/websocket.ts"
export { attachWebSocket, TopicRegistry } from "./server/websocket.ts"
