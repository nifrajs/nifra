/**
 * The provider-neutral half of `@nifrajs/web/cdn`: the path tag every cached page carries, and the
 * purge queue each provider runs its API calls through (coalescing, chunking, `Retry-After`).
 */
import type { CdnPurgeOutcome, CdnPurgeTarget, ISRPlatform } from "../../isr.ts"

/** What a cacheable page tells the CDN: its tags and how long the CDN may serve it. */
export interface CdnCacheInput {
  readonly tags: readonly string[]
  /** Seconds the CDN may serve the page as fresh. */
  readonly maxAge: number
  /** Seconds past `maxAge` the CDN may serve it while it refetches. */
  readonly staleWhileRevalidate: number
  /** Seconds past `maxAge` the CDN may serve it while the origin errors. */
  readonly staleIfError?: number | undefined
}

/** A CDN nifra can tag pages for and purge. Build one with {@link defineCdnProvider}. */
export interface CdnProvider extends CdnPurgeTarget {
  readonly name: string
  /** Most tags one response may carry on this CDN. */
  readonly maxResponseTags: number
  /** Headers that let the CDN store a page under `input.tags` (consumed by the CDN, not the browser). */
  cacheHeaders(input: CdnCacheInput): Readonly<Record<string, string>>
  /** Headers that keep the CDN from storing a page, whatever its rules say. */
  noStoreHeaders(): Readonly<Record<string, string>>
}

/** One purge API call's result. A refusal is `retryable` when sending it again may succeed. */
export type PurgeAttempt =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly retryable: boolean
      readonly reason: string
      readonly retryAfterMs?: number | undefined
      readonly rateLimited?: boolean | undefined
    }

/** What a provider file supplies; {@link defineCdnProvider} adds the queue. */
export interface CdnProviderDefinition {
  readonly name: string
  /** Most tags one purge API call may name. */
  readonly tagsPerCall: number
  readonly maxResponseTags: number
  cacheHeaders(input: CdnCacheInput): Readonly<Record<string, string>>
  noStoreHeaders(): Readonly<Record<string, string>>
  purgeTags(tags: readonly string[]): Promise<PurgeAttempt>
}

/** A purge that did not go through, as reported to {@link PurgeQueueOptions.onError}. */
export interface CdnPurgeError {
  readonly code: "NIFRA_CDN_PURGE_FAILED" | "NIFRA_CDN_RATE_LIMITED"
  readonly provider: string
  readonly reason: string
  /** How many tags the refused call named (never the tags or the credentials). */
  readonly tags: number
  /** Whether the queue gave up on them. */
  readonly final: boolean
}

export interface PurgeQueueOptions {
  /** Tags arriving within this window go out in one call (ms). Default 250. */
  readonly debounceMs?: number
  /** Attempts per call before a retryable refusal is given up on. Default 5. */
  readonly maxAttempts?: number
  /** Longest wait between attempts, `Retry-After` included (ms). Default 60000. */
  readonly maxBackoffMs?: number
  /** Most tags waiting or retrying at once; a purge past it is refused as retryable. Default 5000. */
  readonly maxQueuedTags?: number
  /** Where a refused purge is reported. Default: one `console.error` line per refusal. */
  readonly onError?: (error: CdnPurgeError) => void
  /** Timer for the debounce and the backoff; tests pass their own. */
  readonly sleep?: (ms: number) => Promise<void>
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567"

function base32(bytes: Uint8Array): string {
  let out = ""
  let bits = 0
  let value = 0
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

/**
 * The tag every page a CDN stores carries for its own path, so a path purge works on CDNs that only
 * purge by tag. It hashes the normalized pathname alone: the query and the host stay out, so one purge
 * reaches every query variant and needs no knowledge of the public origin. Two hosts serving the same
 * path share the tag, which can only make a purge reach more than asked, never serve a wrong page.
 */
export async function pathTag(path: string): Promise<string> {
  const cut = path.search(/[?#]/)
  // Joined as text, never resolved: `//host/x` stays a path, as the revalidation endpoint keys it.
  const pathname = new URL(`http://n${cut === -1 ? path : path.slice(0, cut)}`).pathname
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pathname))
  return `nifra.p:${base32(new Uint8Array(digest)).slice(0, 26)}`
}

/** `Retry-After` as milliseconds: delta seconds or an HTTP date; undefined when absent or unreadable. */
export function retryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (value === null) return undefined
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  const at = Date.parse(trimmed)
  return Number.isNaN(at) ? undefined : Math.max(0, at - now)
}

/** A purge API reply read the same way for every HTTP provider. */
export function attemptFromStatus(res: Response, reason: string): PurgeAttempt {
  if (res.ok) return { ok: true }
  const retryAfter = retryAfterMs(res.headers.get("retry-after"))
  if (res.status === 429) {
    return {
      ok: false,
      retryable: true,
      rateLimited: true,
      reason: "rate_limited",
      retryAfterMs: retryAfter,
    }
  }
  if (res.status >= 500) {
    return {
      ok: false,
      retryable: true,
      reason: `${reason}_${res.status}`,
      retryAfterMs: retryAfter,
    }
  }
  return { ok: false, retryable: false, reason: `${reason}_${res.status}` }
}

/** `max-age=..., stale-while-revalidate=...[, stale-if-error=...]` for a CDN TTL header. */
export function cdnDirectives(input: CdnCacheInput): string {
  const parts = [`max-age=${input.maxAge}`, `stale-while-revalidate=${input.staleWhileRevalidate}`]
  if (input.staleIfError !== undefined) parts.push(`stale-if-error=${input.staleIfError}`)
  return parts.join(", ")
}

function positive(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`[nifra/web/cdn] ${name} must be a finite non-negative number`)
  }
  return value
}

interface Waiter {
  readonly tags: ReadonlySet<string>
  readonly platform: ISRPlatform | undefined
  readonly resolve: (outcome: CdnPurgeOutcome) => void
}

type TagState =
  | { state: "accepted" }
  | { state: "queued" }
  | { state: "failed"; retryable: boolean; reason: string }

/**
 * A {@link CdnProvider} from a provider's API calls, with the purge queue in front: tags arriving
 * within `debounceMs` go out together, chunked to the provider's per-call limit and sent one call at
 * a time; a 429 or 5xx is retried with capped exponential backoff that honors `Retry-After`. A
 * `purge` resolves once its tags' first attempt is answered: `accepted`, `queued` (a retry is
 * pending, kept alive with `platform.waitUntil` on edge runtimes), or `failed`.
 */
export function defineCdnProvider(
  definition: CdnProviderDefinition,
  options: PurgeQueueOptions = {},
): CdnProvider {
  const debounceMs = positive(options.debounceMs, 250, "debounceMs")
  const maxAttempts = Math.max(1, Math.floor(positive(options.maxAttempts, 5, "maxAttempts")))
  const maxBackoffMs = positive(options.maxBackoffMs, 60_000, "maxBackoffMs")
  const maxQueuedTags = positive(options.maxQueuedTags, 5000, "maxQueuedTags")
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const report =
    options.onError ??
    ((error: CdnPurgeError) =>
      console.error(
        `[nifra/web/cdn] ${error.code}: ${error.provider} refused a purge of ${error.tags} tag(s) (${error.reason})${error.final ? "" : "; retrying"}`,
      ))

  let pending = new Set<string>()
  let waiters: Waiter[] = []
  let scheduled = false
  let retrying = 0
  // Flushes run one after another, so the provider sees one purge call at a time from this queue.
  let tail: Promise<void> = Promise.resolve()

  const attempt = async (chunk: readonly string[]): Promise<PurgeAttempt> => {
    try {
      return await definition.purgeTags(chunk)
    } catch {
      // The provider's own error text can quote the request; only the kind leaves this function.
      return { ok: false, retryable: true, reason: "network_error" }
    }
  }

  const refusal = (
    chunk: readonly string[],
    result: PurgeAttempt & { ok: false },
    final: boolean,
  ) => {
    try {
      report({
        code: result.rateLimited === true ? "NIFRA_CDN_RATE_LIMITED" : "NIFRA_CDN_PURGE_FAILED",
        provider: definition.name,
        reason: result.reason,
        tags: chunk.length,
        final,
      })
    } catch {
      // A reporter that throws must not strand the purge or the callers waiting on it.
    }
  }

  const retry = async (
    chunk: readonly string[],
    first: PurgeAttempt & { ok: false },
  ): Promise<void> => {
    retrying += chunk.length
    try {
      let last = first
      for (let n = 2; n <= maxAttempts; n++) {
        const backoff = Math.min(maxBackoffMs, 1000 * 2 ** (n - 2))
        await sleep(Math.min(maxBackoffMs, Math.max(backoff, last.retryAfterMs ?? 0)))
        const result = await attempt(chunk)
        if (result.ok) return
        last = result
        if (!result.retryable || n === maxAttempts) {
          refusal(chunk, result, true)
          return
        }
        refusal(chunk, result, false)
      }
    } finally {
      retrying -= chunk.length
    }
  }

  const flush = async (): Promise<void> => {
    const batch = [...pending]
    const settled = waiters
    pending = new Set()
    waiters = []
    scheduled = false
    const states = new Map<string, TagState>()
    const background: Promise<void>[] = []
    try {
      for (let i = 0; i < batch.length; i += definition.tagsPerCall) {
        const chunk = batch.slice(i, i + definition.tagsPerCall)
        const result = await attempt(chunk)
        let state: TagState
        if (result.ok) state = { state: "accepted" }
        else if (result.retryable && maxAttempts > 1) {
          refusal(chunk, result, false)
          background.push(retry(chunk, result))
          state = { state: "queued" }
        } else {
          refusal(chunk, result, true)
          state = { state: "failed", retryable: result.retryable, reason: result.reason }
        }
        for (const tag of chunk) states.set(tag, state)
      }
    } catch {
      // Nothing above should throw; if something does, every caller must still hear back.
      for (const tag of batch) {
        if (!states.has(tag))
          states.set(tag, { state: "failed", retryable: true, reason: "internal_error" })
      }
    }
    const retries = background.length === 0 ? undefined : Promise.all(background)
    for (const waiter of settled) {
      if (retries !== undefined) waiter.platform?.waitUntil?.(retries)
      let failed: (TagState & { state: "failed" }) | undefined
      let queued = false
      for (const tag of waiter.tags) {
        const state = states.get(tag)
        if (state?.state === "failed") failed = failed?.retryable === false ? failed : state
        else if (state?.state === "queued") queued = true
      }
      waiter.resolve(
        failed !== undefined
          ? { cdn: "failed", retryable: failed.retryable, error: failed.reason }
          : queued
            ? { cdn: "queued", retryable: true }
            : { cdn: "accepted", retryable: false },
      )
    }
  }

  return {
    name: definition.name,
    maxResponseTags: definition.maxResponseTags,
    cacheHeaders: (input) => definition.cacheHeaders(input),
    noStoreHeaders: () => definition.noStoreHeaders(),
    async purge(target, platform) {
      const tags = new Set(target.tags ?? [])
      for (const path of target.paths ?? []) tags.add(await pathTag(path))
      if (tags.size === 0) return { cdn: "accepted", retryable: false }
      if (pending.size + retrying + tags.size > maxQueuedTags) {
        return { cdn: "failed", retryable: true, error: "queue_full" }
      }
      const outcome = new Promise<CdnPurgeOutcome>((resolve) => {
        for (const tag of tags) pending.add(tag)
        waiters.push({ tags, platform, resolve })
      })
      if (!scheduled) {
        scheduled = true
        tail = tail.then(() => sleep(debounceMs)).then(flush)
        platform?.waitUntil?.(tail)
      }
      return outcome
    },
  }
}
