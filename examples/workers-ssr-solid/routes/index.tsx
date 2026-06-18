import type { ActionArgs, LoaderArgs, LoaderData } from "@nifrajs/client"
import type { backend } from "../backend"

export const meta = {
  title: "nifra on the edge — Home",
  meta: [{ name: "description", content: "nifra file-routed SSR on Cloudflare Workers" }],
}

// The SAME typed loader + action as the React example (agnostic data layer) — now SSR'd by Solid on
// workerd. The loader reads the count; the action increments it; a client submit revalidates the
// loader (no reload), and with JS off the native POST re-renders (progressive enhancement).
export async function loader({ api }: LoaderArgs<typeof backend>) {
  const res = await api.count.get()
  return { count: res.data?.count ?? 0 }
}

export async function action({ api }: ActionArgs<typeof backend>) {
  await api.count.post()
  return { ok: true }
}

export default function Home(props: { data: LoaderData<typeof loader> }) {
  return (
    <div>
      <h1 id="page">Home</h1>
      <p id="count">count: {props.data.count}</p>
      <form method="post">
        <button id="inc" type="submit">
          increment
        </button>
      </form>
    </div>
  )
}
