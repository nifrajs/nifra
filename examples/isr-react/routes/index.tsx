import type { LoaderArgs, LoaderData } from "@nifrajs/client"
import type { backend } from "../backend"

export const meta = {
  title: "nifra — ISR demo",
  meta: [{ name: "description", content: "Incremental Static Regeneration on nifra" }],
}

// ISR: the `withISR` wrapper (server.ts / worker.ts) caches this page's rendered document and serves
// it stale-while-revalidate. `revalidate` is the freshness window in **seconds** — `createWebApp`
// emits it as the `x-nifra-isr-revalidate` response header, which the wrapper reads to set this page's
// TTL (overriding the wrapper default). 2s keeps the demo snappy. Loader/meta are pure annotated
// exports, so they tree-shake out of the client bundle.
export const revalidate = 2

export async function loader({ api }: LoaderArgs<typeof backend>) {
  const res = await api.page.get()
  return { renders: res.data?.renders ?? 0 }
}

export default function Home(props: { data: LoaderData<typeof loader> }) {
  return (
    <section>
      <p id="renders">server renders: {props.data.renders}</p>
      <p>
        Reload within 2s and this number holds — you're served the cached page (response header{" "}
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
