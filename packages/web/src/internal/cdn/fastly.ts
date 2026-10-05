/**
 * Fastly: `Surrogate-Key` (space-separated) and `Surrogate-Control`, purged in batches of up to 256
 * keys. Soft purge by default, so a purged page is served stale while Fastly refetches it.
 */
import {
  attemptFromStatus,
  type CdnProvider,
  cdnDirectives,
  defineCdnProvider,
  type PurgeQueueOptions,
} from "./core.ts"

export interface FastlyOptions {
  readonly serviceId: string
  /** A Fastly API token with the `purge_select` scope. Keep it in an env var. */
  readonly apiToken: string
  /** Mark purged pages stale instead of dropping them. Default `true`. */
  readonly soft?: boolean
  readonly queue?: PurgeQueueOptions
  /** The fetch purge calls go through; tests pass their own. */
  readonly fetch?: typeof fetch
}

export function fastly(options: FastlyOptions): CdnProvider {
  if (!/^[A-Za-z0-9]+$/.test(options.serviceId)) {
    throw new TypeError("[nifra/web/cdn] fastly: serviceId must be the service's alphanumeric id")
  }
  if (typeof options.apiToken !== "string" || options.apiToken === "") {
    throw new TypeError("[nifra/web/cdn] fastly: apiToken is empty (is the env var set?)")
  }
  const send = options.fetch ?? fetch
  const endpoint = `https://api.fastly.com/service/${options.serviceId}/purge`
  const soft = options.soft !== false
  return defineCdnProvider(
    {
      name: "fastly",
      tagsPerCall: 256,
      maxResponseTags: 1000,
      cacheHeaders: (input) => ({
        "surrogate-key": input.tags.join(" "),
        "surrogate-control": cdnDirectives(input),
      }),
      noStoreHeaders: () => ({ "surrogate-control": "no-store" }),
      async purgeTags(tags) {
        const headers: Record<string, string> = {
          "fastly-key": options.apiToken,
          "content-type": "application/json",
          accept: "application/json",
        }
        if (soft) headers["fastly-soft-purge"] = "1"
        const res = await send(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({ surrogate_keys: tags }),
        })
        await res.body?.cancel()
        return attemptFromStatus(res, "fastly")
      },
    },
    options.queue,
  )
}
