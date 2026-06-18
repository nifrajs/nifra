import type { LoaderData } from "@nifrajs/client"
import { defer } from "@nifrajs/web"
import { Await } from "@nifrajs/web-solid/await"

export const meta = { title: "nifra — streaming" }

// The loader DEFERS slow data: the shell (the <h1> + the fallback) renders immediately, then `feed`
// streams in behind <Await> and resolves on the client without a re-fetch. The 400ms delay stands
// in for a slow upstream call; on a client navigation the value is awaited and arrives resolved.
export function loader() {
  return {
    feed: defer(
      new Promise<string>((resolve) => setTimeout(() => resolve("streamed in after 400ms"), 400)),
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
