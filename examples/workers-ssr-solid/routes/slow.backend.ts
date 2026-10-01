import { defer } from "@nifrajs/web"

// Deferred data: the shell + the <Await fallback> flush immediately, then `feed` streams in behind
// <Suspense> ~400ms later and hydrates with no client re-fetch - streaming SSR on workerd. On a
// client navigation the same data streams over the soft-nav NDJSON endpoint (F10).
export function loader() {
  return {
    feed: defer(
      new Promise<string>((resolve) => setTimeout(() => resolve("streamed from the edge"), 400)),
    ),
  }
}
