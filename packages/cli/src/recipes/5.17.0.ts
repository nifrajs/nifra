import type { UpgradeRecipe } from "./index.ts"

/**
 * Upgrade recipe for Nifra 5.17.
 *
 * No import or dependency moves and no source rewrites. The release bounds the memory that response
 * caching, ISR, typed WebSockets, SSE and in-memory channels may hold, and checks cache eligibility
 * against the final response. Each note names a limit or a contract an app can observe.
 */
export const recipe: UpgradeRecipe = {
  version: "5.17.0",
  pins: [
    { match: "@nifrajs/", to: "5.17.0" },
    { match: "create-nifra", to: "5.17.0" },
    { match: "nifra", to: "5.17.0" },
  ],
  importMoves: [],
  sourceRewrites: [],
  affects: ["@nifrajs/core", "@nifrajs/middleware", "@nifrajs/client", "@nifrajs/web"],
  notes: [
    "`cache()` stores a response only after every later hook has run, and checks it against the final response: a `private` or `no-store` policy, a `Set-Cookie`, or a `Vary` the key does not carry keeps it out of the shared cache. Server component owner routes bypass the generic cache before lookup. Entries written by an earlier version carry no `finalized` flag and count as misses, so the cache repopulates once after the upgrade. A custom `ResponseCacheStore` must keep `finalized` when it stores and returns an entry; a store that drops it never serves a hit.",
    "`withISR` captures at most `maxEntryBytes` of a document (default 2 MiB). A larger page streams to the visitor without being cached, and a stored page over the limit is treated as a miss. `MemoryCacheStore` also takes `maxTotalBytes` (default 64 MiB, two bytes per UTF-16 code unit) and evicts the least recently used page past it. Raise either option when an app caches pages beyond those sizes.",
    "The typed WebSocket client keeps at most `maxPendingMessages` frames (default 256) in `messages()` and in an async `validateReceive` queue. A consumer that falls that far behind ends its iteration and reports through `onError`; a full validation queue also closes the socket with code 4008. Pass a larger `maxPendingMessages` to a call whose consumer reads in bursts.",
    "`stream.signal` of an `sse()` stream now aborts when the stream ends for any reason, including `stream.close()` and a failing producer (the error is the abort reason), not only when the client disconnects. A producer that unsubscribes in an abort listener is released on every path; code that assumed the signal meant a client disconnect should check `req.signal` instead.",
    "`memoryChannelHub` enforces `maxChannels` when the last subscriber of a channel leaves, so an idle hub forgets the oldest inactive histories at once. A `resumeFrom` token for such a channel is refused with `ChannelResumeUnavailableError`, as it already was after a later publish.",
    "`compression({ inlineMax })` gzips a buffered body of up to that many bytes on the calling thread, which measured faster than the thread pool when each core runs its own process. The default is unchanged.",
  ],
}
