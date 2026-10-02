/**
 * `@nifrajs/web/cdn` - put a CDN in front of nifra pages and purge it by tag.
 *
 * `withCdn` wraps the app (or a `withISR` handler) and, on every page a shared cache may store, sets
 * the CDN's tag and TTL headers: the route's `revalidateTags` plus a tag for the page's own path, and
 * the route's `revalidate` as the CDN's freshness. Browsers get `max-age=0, must-revalidate`, because
 * a purge reaches the CDN, never a browser. Every other HTML response is marked no-store for the CDN.
 * `revalidateEndpoint({ cdn })` and `createInvalidator` purge the origin store first, then the CDN.
 *
 * Providers: Cloudflare (a proxied zone, or Workers Cache), Vercel and Fastly; `defineCdnProvider`
 * for any other. Backend-only: a browser build that reaches this module fails.
 */
import "@nifrajs/web/backend-only"
import { isDraftEnabled } from "./draft.ts"
import type { CdnProvider } from "./internal/cdn/core.ts"
import { pathTag } from "./internal/cdn/core.ts"
import {
  type CacheStore,
  type CdnPurgeOutcome,
  type CdnPurgeTarget,
  ISR_REVALIDATE_HEADER,
  ISR_REVALIDATE_TAGS_HEADER,
  type ISRApp,
  type ISRPlatform,
  type ISRQuery,
  isCacheablePage,
  MAX_REVALIDATE_PATHS,
  MAX_REVALIDATE_TAGS,
  normalizeTags,
  openCacheChannel,
  tagsFromHeader,
  urlKeyOf,
  withoutCacheChannel,
} from "./isr.ts"

export {
  type CloudflareWorkersCacheOptions,
  type CloudflareZoneOptions,
  cloudflareWorkersCache,
  cloudflareZone,
  type WorkersCacheLike,
} from "./internal/cdn/cloudflare.ts"
export {
  type CdnCacheInput,
  type CdnProvider,
  type CdnProviderDefinition,
  type CdnPurgeError,
  defineCdnProvider,
  type PurgeAttempt,
  type PurgeQueueOptions,
  pathTag,
} from "./internal/cdn/core.ts"
export { type FastlyOptions, fastly } from "./internal/cdn/fastly.ts"
export { type VercelOptions, vercel } from "./internal/cdn/vercel.ts"
export type { CdnPurgeOutcome, CdnPurgeTarget }

/** What browsers are told about a page the CDN may store: revalidate every time. */
export const CDN_BROWSER_CACHE_CONTROL = "public, max-age=0, must-revalidate"

type Handler = (req: Request, platform?: ISRPlatform) => Response | Promise<Response>

export interface WithCdnOptions {
  readonly provider: CdnProvider
  /**
   * Seconds the CDN may keep serving a page past its freshness while it refetches. Default: the page's
   * own freshness window. With `withISR` underneath, a page can be this much older than ISR's own.
   */
  readonly staleWhileRevalidate?: number
  /** Seconds the CDN may serve a page past its freshness while the origin errors. Default: unset. */
  readonly staleIfError?: number
  /** The draft secret given to `createWebApp`: a draft render is never stored by the CDN. */
  readonly draftSecret?: string
}

const nonNegative = (value: number | undefined, name: string): number | undefined => {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`[nifra/web/cdn] ${name} must be a non-negative integer number of seconds`)
  }
  return value
}

const isHtml = (res: Response): boolean =>
  (res.headers.get("content-type") ?? "").toLowerCase().includes("text/html")

function withHeaders(res: Response, set: Readonly<Record<string, string>>): Response {
  try {
    for (const [name, value] of Object.entries(set)) res.headers.set(name, value)
    return res
  } catch {
    // A `fetch()` response has immutable headers: rebuild it around the same body instead.
    const headers = new Headers(res.headers)
    for (const [name, value] of Object.entries(set)) headers.set(name, value)
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
  }
}

/**
 * Wrap `app` (a `createWebApp` app or a `withISR` handler) so a CDN stores exactly the pages a shared
 * cache may serve to anyone, tagged for purging, for as long as the route's `revalidate` allows.
 * Non-HTML responses (assets, JSON, navigation data) pass through with the app's own headers.
 */
export function withCdn(
  app: ISRApp | Handler,
  options: WithCdnOptions,
): (req: Request, platform?: ISRPlatform) => Promise<Response> {
  const { provider, draftSecret } = options
  const swr = nonNegative(options.staleWhileRevalidate, "staleWhileRevalidate")
  const staleIfError = nonNegative(options.staleIfError, "staleIfError")
  openCacheChannel(app)
  const fetchOf: Handler =
    typeof app === "function" ? app : (req, platform) => app.fetch(req, platform)
  return async (req, platform) => {
    const res = await fetchOf(req, platform)
    const advertised = res.headers.get(ISR_REVALIDATE_HEADER)
    const tags = tagsFromHeader(res.headers.get(ISR_REVALIDATE_TAGS_HEADER))
    const out = withoutCacheChannel(res)
    if (!isHtml(out)) return out
    const seconds = advertised === null ? Number.NaN : Math.floor(Number(advertised))
    const storable =
      Number.isFinite(seconds) &&
      seconds > 0 &&
      isCacheablePage(req, out) &&
      !(draftSecret !== undefined && (await isDraftEnabled(req, draftSecret)))
    if (!storable) return withHeaders(out, provider.noStoreHeaders())
    const pageTags = [...tags, await pathTag(new URL(req.url).pathname)]
    return withHeaders(out, {
      ...provider.cacheHeaders({
        tags: pageTags.slice(-provider.maxResponseTags),
        maxAge: seconds,
        staleWhileRevalidate: swr ?? seconds,
        staleIfError,
      }),
      "cache-control": CDN_BROWSER_CACHE_CONTROL,
    })
  }
}

export interface InvalidatorOptions {
  /** The ISR store to purge first. */
  readonly store?: CacheStore
  /** The CDN to purge after the store. */
  readonly cdn?: CdnPurgeTarget
  /**
   * The site's public origin (`https://example.com`), for the store keys of purged paths under
   * `withISR`'s default key. Not needed with `key`, or without a store.
   */
  readonly origin?: string
  /** A store key for a path; must match the `withISR` `key`. Return `null` for a path never cached. */
  readonly key?: (path: string) => string | null
  /** The `query` policy given to `withISR`. Default `"bypass"`. Ignored with `key`. */
  readonly query?: ISRQuery
}

export interface InvalidateResult {
  readonly origin: "done" | "skipped"
  readonly cdn: CdnPurgeOutcome["cdn"] | "skipped"
  readonly retryable: boolean
  readonly error?: string
}

/**
 * Purge pages after a mutation, from app code: `await invalidate({ tags: ["product:42"] })`. The
 * origin store goes first, so a CDN refetch cannot repopulate from a stale origin entry. At most 32
 * tags and 100 paths a call.
 */
export function createInvalidator(options: InvalidatorOptions): {
  invalidate(
    target: { readonly tags?: readonly string[]; readonly paths?: readonly string[] },
    platform?: ISRPlatform,
  ): Promise<InvalidateResult>
} {
  const { store, cdn } = options
  let keyOf: ((path: string) => string | null) | undefined = options.key
  if (keyOf === undefined && store !== undefined) {
    if (options.origin === undefined) {
      throw new TypeError(
        "[nifra/web/cdn] createInvalidator: a store needs `origin` (or `key`) to find a path's entry",
      )
    }
    const origin = new URL(options.origin).origin
    const urlKey = urlKeyOf(options.query)
    keyOf = (path) => urlKey(new URL(origin + path))
  }
  return {
    async invalidate(target, platform) {
      const tags = normalizeTags(target.tags ?? [])
      const paths = [...new Set(target.paths ?? [])]
      if (tags.length > MAX_REVALIDATE_TAGS || paths.length > MAX_REVALIDATE_PATHS) {
        throw new RangeError(
          "[nifra/web/cdn] invalidate takes at most 32 tags and 100 paths a call",
        )
      }
      for (const path of paths) {
        if (typeof path !== "string" || !path.startsWith("/")) {
          throw new TypeError("[nifra/web/cdn] invalidate paths must start with /")
        }
      }
      let origin: InvalidateResult["origin"] = "skipped"
      if (store !== undefined) {
        if (tags.length > 0 && store.invalidateTag === undefined) {
          throw new TypeError("[nifra/web/cdn] this store cannot invalidate by tag")
        }
        for (const path of paths) {
          const key = keyOf?.(path)
          if (key !== null && key !== undefined) await store.delete(key)
        }
        for (const tag of tags) await store.invalidateTag?.(tag)
        origin = "done"
      }
      if (cdn === undefined) return { origin, cdn: "skipped", retryable: false }
      const outcome = await cdn.purge({ tags, paths }, platform)
      return { origin, ...outcome }
    },
  }
}
