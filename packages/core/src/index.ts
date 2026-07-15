/**
 * @nifrajs/core — Bun-native, contract-first HTTP framework.
 *
 * The router is the perf-critical heart; the server and inline API are built on
 * the unified route descriptor.
 */

/**
 * Current package version. A hardcoded literal on purpose — core runs on the edge (no fs), so it can't
 * read its own package.json at runtime. `scripts/version.ts` rewrites it on every release bump and
 * `check:publish` asserts it equals `@nifrajs/core`'s package version, so the literal can't go stale
 * (it shipped at "0.0.0" through 1.0.0 before those guards existed). Kept narrow (`as const`) so
 * consumers can pin it at the type level — see `test/version.test-d.ts`.
 */
export const VERSION = "1.13.0" as const

export type Version = typeof VERSION

export * from "./assurance.ts"
export * from "./capabilities.ts"
export * from "./causality.ts"
export * from "./classification.ts"
export * from "./diff.ts"
export { FrameworkError, RouteConfigError, type RouteConfigErrorCode } from "./errors.ts"
export * from "./idempotency.ts"
export { FRAMEWORK_NAME, type FrameworkName } from "./internal/brand.ts"
export * from "./invariants.ts"
export * from "./ledger.ts"
export * from "./manifest.ts"
export * from "./mount.ts"
export * from "./reflection.ts"
export * from "./router/pattern.ts"
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
export {
  type SSEContext,
  type SSEInit,
  type SSEMessage,
  type SSEStream,
  sse,
  type TypedSSEStream,
  typedSSEStream,
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
