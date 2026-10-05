/**
 * Cloudflare: a proxied zone in front of the origin, and Workers Cache in front of a Worker. Both read
 * `Cache-Tag` and `Cloudflare-CDN-Cache-Control` and strip them before the browser; the zone purges
 * through the API (at most 100 tags a call; the Free plan allows 5 calls a minute), Workers Cache
 * through the Worker's own `cache.purge` (always Free-plan limits).
 */
import {
  attemptFromStatus,
  type CdnCacheInput,
  type CdnProvider,
  cdnDirectives,
  defineCdnProvider,
  type PurgeQueueOptions,
} from "./core.ts"

const headersFor = (input: CdnCacheInput): Record<string, string> => ({
  "cache-tag": input.tags.join(","),
  "cloudflare-cdn-cache-control": cdnDirectives(input),
})
const NO_STORE = { "cloudflare-cdn-cache-control": "no-store" }

export interface CloudflareZoneOptions {
  /** The zone id (32 hex characters, on the zone's Overview page). */
  readonly zoneId: string
  /** An API token scoped to Zone > Cache Purge for this zone. Keep it in an env binding. */
  readonly apiToken: string
  readonly queue?: PurgeQueueOptions
  /** The fetch purge calls go through; tests pass their own. */
  readonly fetch?: typeof fetch
}

/**
 * A Cloudflare zone proxying the origin. HTML is only cached by a Cache Rule that makes it eligible,
 * and the zone's cache ignores `Vary`: the rule must also bypass the cache when the request carries
 * `x-nifra-data` (soft navigations fetch the page URL with that header). `nifra cdn-check` tests both.
 */
export function cloudflareZone(options: CloudflareZoneOptions): CdnProvider {
  if (!/^[a-f0-9]{32}$/.test(options.zoneId)) {
    throw new TypeError(
      "[nifra/web/cdn] cloudflareZone: zoneId must be the 32-character hex zone id",
    )
  }
  if (typeof options.apiToken !== "string" || options.apiToken === "") {
    throw new TypeError(
      "[nifra/web/cdn] cloudflareZone: apiToken is empty (is the env binding set?)",
    )
  }
  const send = options.fetch ?? fetch
  const endpoint = `https://api.cloudflare.com/client/v4/zones/${options.zoneId}/purge_cache`
  return defineCdnProvider(
    {
      name: "cloudflare",
      tagsPerCall: 100,
      maxResponseTags: 1000,
      cacheHeaders: headersFor,
      noStoreHeaders: () => NO_STORE,
      async purgeTags(tags) {
        const res = await send(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.apiToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ tags }),
        })
        const attempt = attemptFromStatus(res, "cloudflare")
        if (!res.ok) {
          await res.body?.cancel()
          return attempt
        }
        // A 200 can still carry `success: false`; only `true` means the purge was received.
        const body: unknown = await res.json().catch(() => null)
        const field = (from: unknown, name: string): unknown =>
          typeof from === "object" && from !== null ? Reflect.get(from, name) : undefined
        if (field(body, "success") === true) return attempt
        const errors = field(body, "errors")
        const code = field(Array.isArray(errors) ? errors[0] : undefined, "code")
        return {
          ok: false,
          retryable: false,
          reason: typeof code === "number" ? `cloudflare_error_${code}` : "cloudflare_unsuccessful",
        }
      },
    },
    options.queue,
  )
}

/** The Worker's cache binding: `import { cache } from "cloudflare:workers"`, or `ctx.cache`. */
export interface WorkersCacheLike {
  purge(options: { tags?: string[]; pathPrefixes?: string[] }): Promise<{
    success: boolean
    errors?: readonly { code?: number; message?: string }[]
  }>
}

export interface CloudflareWorkersCacheOptions {
  /** `import { cache } from "cloudflare:workers"` (needs `[cache] enabled = true` in wrangler). */
  readonly cache: WorkersCacheLike
  /**
   * Whether the Worker serves different content per hostname. Workers Cache keys entries by path, not
   * host, so such an app would serve one host's page to another: `true` is refused.
   */
  readonly hostRouted?: boolean
  readonly queue?: PurgeQueueOptions
}

/** Workers Cache in front of the Worker serving the app. Purges are scoped to the calling entrypoint. */
export function cloudflareWorkersCache(options: CloudflareWorkersCacheOptions): CdnProvider {
  if (options.hostRouted === true) {
    throw new Error(
      "[nifra/web/cdn] NIFRA_CDN_HOST_ROUTED: Workers Cache keys pages by path, not host, so a Worker that serves different content per hostname would serve one host's page to another. Put a Cloudflare zone (cloudflareZone) in front instead, or serve each host from its own Worker.",
    )
  }
  if (typeof options.cache?.purge !== "function") {
    throw new TypeError(
      '[nifra/web/cdn] cloudflareWorkersCache: pass `cache` from `import { cache } from "cloudflare:workers"`',
    )
  }
  return defineCdnProvider(
    {
      name: "cloudflare-workers-cache",
      tagsPerCall: 100,
      maxResponseTags: 1000,
      cacheHeaders: headersFor,
      noStoreHeaders: () => NO_STORE,
      async purgeTags(tags) {
        const result = await options.cache.purge({ tags: [...tags] })
        if (result.success) return { ok: true }
        const first = result.errors?.[0]
        // A rate-limit refusal is the one worth retrying; anything else is configuration.
        const limited = /rate/i.test(first?.message ?? "")
        return {
          ok: false,
          retryable: limited,
          rateLimited: limited,
          reason:
            typeof first?.code === "number"
              ? `workers_cache_${first.code}`
              : "workers_cache_refused",
        }
      },
    },
    options.queue,
  )
}
