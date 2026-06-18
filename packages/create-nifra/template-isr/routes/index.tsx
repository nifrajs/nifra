import type { LoaderArgs, LoaderData } from "@nifrajs/client"
import type { backend } from "../backend"

export const meta = {
  title: "nifra + ISR",
  meta: [{ name: "description", content: "Incremental Static Regeneration on nifra." }],
}

// ISR: the `withISR` wrapper (worker.ts / server.ts) caches this page and serves it
// stale-while-revalidate. `revalidate` is the freshness window in SECONDS — nifra emits it as the
// `x-nifra-isr-revalidate` header, which the wrapper reads to set this page's TTL. Loader/meta are
// pure annotated exports, so they tree-shake out of the client bundle.
export const revalidate = 10

export async function loader({ api }: LoaderArgs<typeof backend>) {
  const res = await api.page.get()
  return { renders: res.data?.renders ?? 0 }
}

export default function Home(props: { data: LoaderData<typeof loader> }) {
  return (
    <section>
      <p>
        server renders: <b>{props.data.renders}</b>
      </p>
      <p>
        Reload within {revalidate}s and this holds — you're served the cached page (response header{" "}
        <code>x-nifra-isr: hit</code>). After the window, the next request gets the stale page
        instantly (<code>stale</code>) while a fresh copy regenerates behind it. Edit{" "}
        <code>routes/index.tsx</code> to begin.
      </p>
    </section>
  )
}
