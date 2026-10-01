import type { LoaderData } from "@nifrajs/client"
import { Await } from "@nifrajs/web-react/await"
import type { loader } from "./slow.backend.ts"

export const meta = { title: "nifra - streaming" }

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
      {/* A deferred value nested in an array of objects - streams + hydrates on its own. */}
      <Await resolve={props.data.panels[0].chart} fallback={<p id="chart-fallback">chart…</p>}>
        {(chart) => <p id="chart-content">chart: {chart.join(",")}</p>}
      </Await>
    </div>
  )
}
