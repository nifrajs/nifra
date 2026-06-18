import type { LoaderData } from "@nifrajs/client"
import { defer } from "@nifrajs/web"
import { Await } from "@nifrajs/web-react/await"

export const meta = { title: "nifra on the edge — streaming" }

// Deferred data: the shell + the <Await fallback> flush immediately, then `feed` streams in behind
// <Suspense> ~400ms later and hydrates with no client re-fetch — streaming SSR on workerd. On a
// client navigation the same data streams over the soft-nav NDJSON endpoint (F10).
export function loader() {
  return {
    feed: defer(
      new Promise<string>((resolve) => setTimeout(() => resolve("streamed from the edge"), 400)),
    ),
  }
}

export default function SlowPage(props: { data: LoaderData<typeof loader> }) {
  return (
    <div>
      <h1 id="page">Streaming demo</h1>
      <Await
        resolve={props.data.feed}
        fallback={<p id="slow-fallback">loading…</p>}
        errorFallback={(error) => <p id="slow-error">failed: {String(error)}</p>}
      >
        {(feed) => <p id="slow-content">{feed}</p>}
      </Await>
    </div>
  )
}
