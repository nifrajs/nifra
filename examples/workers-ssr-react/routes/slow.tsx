import type { LoaderData } from "@nifrajs/client"
import { Await } from "@nifrajs/web-react/await"
import type { loader } from "./slow.backend.ts"

export const meta = { title: "nifra on the edge - streaming" }

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
