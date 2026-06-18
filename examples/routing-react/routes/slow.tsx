import type { LoaderData } from "@nifrajs/client"
import { defer } from "@nifrajs/web"
import { Await } from "@nifrajs/web-react/await"

export const meta = { title: "nifra — streaming" }

// The loader DEFERS slow data: the shell (the <h1> + the fallback) renders immediately, then `feed`
// streams in behind <Await> and hydrates without a client re-fetch. The 400ms delay stands in for
// a slow upstream call; on a client navigation the value is awaited and arrives resolved.
export function loader() {
  return {
    feed: defer(
      new Promise<string>((resolve) => setTimeout(() => resolve("streamed in after 400ms"), 400)),
    ),
    // NESTED defer — inside an array → object. `defer()` works at any depth, not just top-level keys:
    // each marker streams + hydrates independently behind its own <Await>.
    panels: [
      {
        id: "metrics",
        chart: defer(
          new Promise<number[]>((resolve) => setTimeout(() => resolve([3, 1, 4, 1, 5]), 250)),
        ),
      },
    ],
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
      {/* A deferred value nested in an array of objects — streams + hydrates on its own. */}
      <Await resolve={props.data.panels[0].chart} fallback={<p id="chart-fallback">chart…</p>}>
        {(chart) => <p id="chart-content">chart: {chart.join(",")}</p>}
      </Await>
    </div>
  )
}
