import type { LoaderData } from "@nifrajs/client"
import type { loader } from "./index.backend.ts"

export const meta = {
  title: "nifra - ISR demo",
  meta: [{ name: "description", content: "Incremental Static Regeneration on nifra" }],
}

export default function Home(props: { data: LoaderData<typeof loader> }) {
  return (
    <section>
      <p id="renders">server renders: {props.data.renders}</p>
      <p>
        Reload within 2s and this number holds - you're served the cached page (response header{" "}
        <code>x-nifra-isr: hit</code>). After 2s the next request gets the stale page instantly (
        <code>x-nifra-isr: stale</code>) while a fresh copy regenerates behind it, so the number
        bumps on the request after that. A fresh deploy starts at <code>miss</code>.
      </p>
      <p>
        Force an immediate refresh with an on-demand purge:{" "}
        <code>
          curl -X POST 'http://localhost:3000/__nifra/revalidate?path=/' -H
          'x-nifra-revalidate-token: dev-secret'
        </code>
      </p>
    </section>
  )
}
