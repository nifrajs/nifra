/**
 * `@nifrajs/middleware` — composable, dependency-free middleware + plugins applied via `app.use()`.
 * The hardening set (`cors`, `rateLimit`, `securityHeaders`) returns a `@nifrajs/core` `Middleware`
 * (a hook bundle, context-agnostic). The seeded plugins (`requestId`, `logger`, `etag`, `bearer`,
 * `apiKey`) use the `definePlugin` convention — named (idempotent dedupe), and `requestId` threads
 * `c.requestId` into the handler context.
 */

export {
  type AdmissionControllerHandle,
  type AdmissionEvidence,
  type AdmissionOptions,
  type AdmissionPolicy,
  type AdmissionSnapshot,
  createAdmissionController,
  createEventLoopLagSampler,
  type ShedReason,
} from "./admission.ts"
export {
  type BasicAuthPlugin,
  type BasicAuthStaticOptions,
  type BasicAuthVerifyOptions,
  basicAuth,
} from "./basic-auth.ts"
export { type BodyLimitOptions, bodyLimit } from "./body-limit.ts"
export {
  type CachedResponse,
  type CacheOptions,
  cache,
  MemoryResponseCache,
  type MemoryResponseCacheOptions,
  type ResponseCacheStore,
  responseCache,
} from "./cache.ts"
export { type CacheControlOptions, cacheControl } from "./cache-control.ts"
export { type Composable, combine, namedCombine } from "./combine.ts"
export { type CompressionOptions, compression } from "./compression.ts"
export { type CorsOptions, cors } from "./cors.ts"
export {
  type CsrfOptions,
  createCsrfToken,
  csrf,
  verifyCsrfToken,
} from "./csrf.ts"
export { type ETagOptions, etag } from "./etag.ts"
export { type HealthcheckOptions, healthcheck } from "./healthcheck.ts"
export {
  type IdempotencyClaim,
  type IdempotencyOptions,
  type IdempotencyRecord,
  type IdempotencyStore,
  idempotency,
  MemoryIdempotencyStore,
  type MemoryIdempotencyStoreOptions,
} from "./idempotency.ts"
export { type IpMatcher, type IpRestrictionOptions, ipRestriction } from "./ip-restriction.ts"
export {
  type JwkKey,
  type JwksOptions,
  type JwtAlgorithm,
  type JwtClaims,
  type JwtHeader,
  type JwtKeyResolver,
  type JwtOptions,
  type JwtPlugin,
  type JwtVerificationKey,
  jwk,
  jwks,
  jwt,
  tryVerifyJwt,
  type VerifiedJwt,
  type VerifyJwtOptions,
  type VerifyJwtResult,
  verifyJwt,
} from "./jwt.ts"
export {
  type LanguageMatch,
  type LanguageOptions,
  language,
  pickLanguage,
} from "./language.ts"
export { type LoggerOptions, logger, type RequestLogFields } from "./logger.ts"
export { type MethodOverrideOptions, methodOverride } from "./method-override.ts"
export {
  buildOpenApiDocument,
  type OpenApiInfo,
  type OpenApiOptions,
  type OpenApiServer,
  type OpenApiTag,
  type OpenApiUiOptions,
  openapi,
  type RouteLike,
  type SecurityRequirement,
} from "./openapi.ts"
export { type PoweredByOptions, poweredBy } from "./powered-by.ts"
export { type PrettyJsonOptions, prettyJson } from "./pretty-json.ts"
export {
  MemoryStore,
  type MemoryStoreOptions,
  type RateLimitOptions,
  type RateLimitResult,
  type RateLimitStore,
  rateLimit,
} from "./rate-limit.ts"
export { type RequestIdOptions, requestId } from "./request-id.ts"
export { type SecurityHeadersOptions, securityHeaders } from "./security-headers.ts"
export { type TimingControls, type TimingMetric, type TimingOptions, timing } from "./timing.ts"
export {
  type ApiKeyStaticOptions,
  type ApiKeyVerifyOptions,
  type AuthPlugin,
  apiKey,
  type BearerOptions,
  bearer,
} from "./token-auth.ts"
export {
  appendTrailingSlash,
  type TrailingSlashOptions,
  trimTrailingSlash,
} from "./trailing-slash.ts"
