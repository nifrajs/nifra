/**
 * Vercel's CDN: `Vercel-Cache-Tag` and `Vercel-CDN-Cache-Control`, both consumed by Vercel and kept
 * from the browser. Tags are case-sensitive; at most 16 a purge call and 128 a response.
 */
import {
  attemptFromStatus,
  type CdnProvider,
  cdnDirectives,
  defineCdnProvider,
  type PurgeQueueOptions,
} from "./core.ts"

type TagPurge = (tags: string | string[]) => Promise<unknown>

export type VercelOptions = (
  | {
      /** `invalidateByTag` from `@vercel/functions`: inside a Vercel Function, no token needed. */
      readonly invalidateByTag: TagPurge
      /** `dangerouslyDeleteByTag` from `@vercel/functions`, for `mode: "delete"`. */
      readonly dangerouslyDeleteByTag?: TagPurge
    }
  | {
      /** A Vercel access token for the REST API. Keep it in an env var. */
      readonly token: string
      readonly projectId: string
      readonly teamId?: string
      /** Purge one environment only; default both. */
      readonly target?: "production" | "preview"
      /** The fetch purge calls go through; tests pass their own. */
      readonly fetch?: typeof fetch
    }
) & {
  /**
   * `invalidate` (default) marks tagged pages stale: the next visitor gets the old page while Vercel
   * refetches. `delete` drops them, so the next visitors wait on the origin together.
   */
  readonly mode?: "invalidate" | "delete"
  readonly queue?: PurgeQueueOptions
}

export function vercel(options: VercelOptions): CdnProvider {
  const mode = options.mode ?? "invalidate"
  let purgeTags: (
    tags: readonly string[],
  ) => ReturnType<Parameters<typeof defineCdnProvider>[0]["purgeTags"]>
  if ("invalidateByTag" in options) {
    const fn = mode === "delete" ? options.dangerouslyDeleteByTag : options.invalidateByTag
    if (typeof fn !== "function") {
      throw new TypeError(
        `[nifra/web/cdn] vercel: pass ${mode === "delete" ? "dangerouslyDeleteByTag" : "invalidateByTag"} from @vercel/functions`,
      )
    }
    purgeTags = async (tags) => {
      await fn([...tags])
      return { ok: true }
    }
  } else {
    if (typeof options.token !== "string" || options.token === "") {
      throw new TypeError("[nifra/web/cdn] vercel: token is empty (is the env var set?)")
    }
    if (typeof options.projectId !== "string" || options.projectId === "") {
      throw new TypeError("[nifra/web/cdn] vercel: projectId is required")
    }
    const send = options.fetch ?? fetch
    const query = new URLSearchParams({ projectIdOrName: options.projectId })
    if (options.teamId !== undefined) query.set("teamId", options.teamId)
    const path = mode === "delete" ? "dangerously-delete-by-tags" : "invalidate-by-tags"
    const endpoint = `https://api.vercel.com/v1/edge-cache/${path}?${query}`
    const token = options.token
    const target = options.target
    purgeTags = async (tags) => {
      const res = await send(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(target === undefined ? { tags } : { tags, target }),
      })
      await res.body?.cancel()
      return attemptFromStatus(res, "vercel")
    }
  }
  return defineCdnProvider(
    {
      name: "vercel",
      tagsPerCall: 16,
      maxResponseTags: 128,
      cacheHeaders: (input) => ({
        "vercel-cache-tag": input.tags.join(","),
        "vercel-cdn-cache-control": cdnDirectives(input),
      }),
      noStoreHeaders: () => ({ "vercel-cdn-cache-control": "no-store" }),
      purgeTags,
    },
    options.queue,
  )
}
