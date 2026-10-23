/**
 * Partial prerendering limits and defaults. Internal while the feature is experimental: every
 * number the plan names lives here once, so a deployment overrides it in one object and the request
 * path reads the resolved copy rather than a scattered constant.
 */

/** Overrides for {@link PPR_DEFAULTS}. Every field is optional; an omitted one keeps its default. */
export interface PprOptions {
  /** A hole's deadline when its boundary sets no `timeout`. */
  readonly holeTimeoutMs?: number
  /** The largest `timeout` a boundary may set, and the cap on a route's total deadline. */
  readonly maxHoleTimeoutMs?: number
  /** Added to the largest hole timeout to give the route's total deadline. */
  readonly totalDeadlineSlackMs?: number
  /** Dynamic plus shared boundaries one PPR route may declare. */
  readonly maxHolesPerRoute?: number
  /** Shell entries one route may keep in the memory store. */
  readonly shellEntriesPerRoute?: number
  /**
   * Bytes every shell entry in the memory store may hold together: its document, an estimate of the
   * heap its loader data holds, and its key. An entry over the whole budget is served but not kept.
   */
  readonly shellStoreBytes?: number
  /** How long a `notFound()` shell is cached. */
  readonly notFoundTtlSeconds?: number
  /** Shell builds one route may run at once; requests over it get the blocking render. */
  readonly shellBuildConcurrency?: number
  /**
   * Once the store is full, requests one shell key must see before its shell is built and may push
   * an older one out. The ones before stream the page whole, each hole as it settles, so a path
   * visited once cannot evict a popular one. While the store has room, every key builds at once.
   */
  readonly shellAfterRequests?: number
  /** A failing rebuild keeps serving the stale shell for `revalidate` times this... */
  readonly staleOnErrorFactor?: number
  /** ...but never longer than this. */
  readonly maxStaleOnErrorSeconds?: number
  /** Requests that get the blocking render instead of a stream: a user-agent pattern or a predicate. */
  readonly blockingFor?: RegExp | ((request: Request) => boolean)
  /** Abandoned invocations at which one boundary stops being admitted. */
  readonly boundaryAbandonedTrip?: number
  /** Abandoned invocations per process at which boundaries holding any stop being admitted. */
  readonly processAbandonedTrip?: number
  /** Abandoned invocations per process at which no hole is admitted. */
  readonly admissionStop?: number
  /** How long after its abort a still-pending invocation counts as abandoned. */
  readonly abandonGraceMs?: number
  /** PPR responses per process with hole loaders still running. */
  readonly maxHoleWork?: number
  /** How long after the total deadline an undrained stream is kept before it is aborted. */
  readonly writeGraceMs?: number
  /** Unsent bytes one response may queue. */
  readonly maxUnsentBytesPerResponse?: number
  /** Unsent bytes every PPR response in the process may queue together. */
  readonly maxUnsentBytes?: number
  /** Serialized size of one hole frame. */
  readonly frameBytes?: number
  /** The shell is padded to at least this many bytes; Safari holds back smaller first chunks. */
  readonly minShellBytes?: number
  /**
   * When hole HTML is checked for script, handlers and other escapes before it is framed:
   * `"always"`, or `"development"` only. The check costs about 20 us per KB of hole HTML; turn it off
   * in production only when a strict CSP already blocks inline script.
   */
  readonly holeHtmlValidation?: "always" | "development"
  /**
   * Whether a page left with holes pending posts a cancel beacon, so their loaders stop before their
   * deadline. Off by default on Cloudflare Workers, where the beacon reaches another isolate.
   */
  readonly cancelBeacon?: boolean
  /**
   * How long a process serves a shell or shared hole it wrote to or read from the shared store before
   * reading it there again, so a purge another process made reaches this one. 0 reads it every time.
   */
  readonly sharedRecheckMs?: number
}

export type ResolvedPprOptions = {
  readonly [K in keyof PprOptions]-?: Exclude<PprOptions[K], undefined>
}

/**
 * Crawlers that read the document without running streamed scripts, so they get the blocking render.
 * The same set Next.js treats as HTML-limited bots. Googlebot itself is absent on purpose: it renders
 * JavaScript. `[\w-]-Google` matches what `[\w-]+-Google` does without backtracking at every position.
 */
export const HTML_LIMITED_BOTS: RegExp =
  /[\w-]-Google|Google-[\w-]|Chrome-Lighthouse|Slurp|DuckDuckBot|baiduspider|yandex|sogou|bitlybot|tumblr|vkShare|quora link preview|redditbot|ia_archiver|Bingbot|BingPreview|applebot|facebookexternalhit|facebookcatalog|Twitterbot|LinkedInBot|Slackbot|Discordbot|WhatsApp|SkypeUriPreview|Yeti|googleweblight/i

const MB = 1024 * 1024

export const PPR_DEFAULTS: ResolvedPprOptions = Object.freeze({
  holeTimeoutMs: 5_000,
  maxHoleTimeoutMs: 30_000,
  totalDeadlineSlackMs: 1_000,
  maxHolesPerRoute: 32,
  shellEntriesPerRoute: 10_000,
  shellStoreBytes: 64 * MB,
  notFoundTtlSeconds: 60,
  shellBuildConcurrency: 4,
  shellAfterRequests: 2,
  staleOnErrorFactor: 10,
  maxStaleOnErrorSeconds: 86_400,
  blockingFor: HTML_LIMITED_BOTS,
  boundaryAbandonedTrip: 64,
  processAbandonedTrip: 1_024,
  admissionStop: 4_096,
  abandonGraceMs: 100,
  maxHoleWork: 1_024,
  writeGraceMs: 5_000,
  maxUnsentBytesPerResponse: MB,
  maxUnsentBytes: 64 * MB,
  frameBytes: 256 * 1024,
  minShellBytes: 1_024,
  holeHtmlValidation: "always",
  cancelBeacon: true,
  sharedRecheckMs: 1_000,
})

/**
 * On Cloudflare Workers an isolate's memory is shared by everything it runs, and a beacon almost
 * always reaches another isolate than the one running the holes.
 */
const WORKERS_DEFAULTS: Partial<ResolvedPprOptions> = Object.freeze({
  shellStoreBytes: 8 * MB,
  cancelBeacon: false,
})

const onWorkers = (): boolean => globalThis.navigator?.userAgent === "Cloudflare-Workers"

type NumericKey = {
  [K in keyof ResolvedPprOptions]: ResolvedPprOptions[K] extends number ? K : never
}[keyof ResolvedPprOptions]

const optionError = (message: string): TypeError => new TypeError(`[nifra/web] ppr: ${message}`)

function assertOrdered(options: ResolvedPprOptions, smaller: NumericKey, larger: NumericKey): void {
  if (options[smaller] > options[larger]) {
    throw optionError(
      `${smaller} (${options[smaller]}) must not exceed ${larger} (${options[larger]})`,
    )
  }
}

/** The latest request a shell may wait for; the canary check requests a path this many times. */
export const MAX_SHELL_AFTER_REQUESTS = 8

/**
 * Merge `overrides` over {@link PPR_DEFAULTS} and check the result. Unknown keys, non-integers and
 * limits that contradict each other throw at startup, never on a request.
 */
export function resolvePprOptions(overrides: PprOptions = {}): ResolvedPprOptions {
  for (const key of Object.keys(overrides)) {
    if (!Object.hasOwn(PPR_DEFAULTS, key)) throw optionError(`unknown option "${key}"`)
  }
  const defined = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  )
  const resolved: ResolvedPprOptions = {
    ...PPR_DEFAULTS,
    ...(onWorkers() ? WORKERS_DEFAULTS : undefined),
    ...defined,
  }
  for (const [key, value] of Object.entries(resolved)) {
    if (key === "blockingFor" || key === "holeHtmlValidation" || key === "cancelBeacon") continue
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw optionError(`${key} must be a non-negative integer, got ${String(value)}`)
    }
  }
  for (const key of [
    "holeTimeoutMs",
    "maxHolesPerRoute",
    "shellBuildConcurrency",
    "shellAfterRequests",
    "boundaryAbandonedTrip",
    "maxHoleWork",
    "maxUnsentBytesPerResponse",
    "frameBytes",
  ] as const) {
    if (resolved[key] === 0) throw optionError(`${key} must be at least 1`)
  }
  if (resolved.shellAfterRequests > MAX_SHELL_AFTER_REQUESTS) {
    throw optionError(
      `shellAfterRequests must be at most ${MAX_SHELL_AFTER_REQUESTS}, got ${resolved.shellAfterRequests}`,
    )
  }
  const blockingFor = resolved.blockingFor
  if (!(blockingFor instanceof RegExp) && typeof blockingFor !== "function") {
    throw optionError("blockingFor must be a RegExp or a function of the request")
  }
  if (resolved.holeHtmlValidation !== "always" && resolved.holeHtmlValidation !== "development") {
    throw optionError(
      `holeHtmlValidation must be "always" or "development", got ${String(resolved.holeHtmlValidation)}`,
    )
  }
  if (typeof resolved.cancelBeacon !== "boolean") {
    throw optionError(`cancelBeacon must be a boolean, got ${String(resolved.cancelBeacon)}`)
  }
  // A global or sticky pattern keeps `lastIndex` between `test` calls, so one bot would alternate.
  if (blockingFor instanceof RegExp && (blockingFor.global || blockingFor.sticky)) {
    throw optionError("blockingFor must not use the g or y flag")
  }
  assertOrdered(resolved, "holeTimeoutMs", "maxHoleTimeoutMs")
  assertOrdered(resolved, "boundaryAbandonedTrip", "processAbandonedTrip")
  assertOrdered(resolved, "processAbandonedTrip", "admissionStop")
  assertOrdered(resolved, "frameBytes", "maxUnsentBytesPerResponse")
  assertOrdered(resolved, "maxUnsentBytesPerResponse", "maxUnsentBytes")
  return Object.freeze(resolved)
}

/** A route's total deadline: its largest hole timeout plus the slack, capped. */
export function totalDeadlineMs(
  options: ResolvedPprOptions,
  holeTimeouts: readonly number[],
): number {
  let largest = 0
  for (const timeout of holeTimeouts) if (timeout > largest) largest = timeout
  return Math.min(largest + options.totalDeadlineSlackMs, options.maxHoleTimeoutMs)
}

export { wantsBlockingRender } from "./contract.ts"
