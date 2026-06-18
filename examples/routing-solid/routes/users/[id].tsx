import type { LoaderArgs, LoaderData } from "@nifrajs/client"
import type { MetaArgs } from "@nifrajs/web"
import { createSignal } from "solid-js"
import type { backend } from "../../backend"

// Typed via the annotation (pure type → tree-shaken from the client). `ctx.api` is the typed
// in-process client; the return flows to the page's `data` prop via LoaderData.
export async function loader({ api, params }: LoaderArgs<typeof backend>) {
  const res = await api.users({ id: params.id ?? "" }).get()
  return { user: res.data }
}

// Dynamic head — a function of the loader data. Updates the title on client navigation.
export function meta({ data }: MetaArgs<LoaderData<typeof loader>>) {
  return { title: data.user ? `User #${data.user.id}` : "User" }
}

export default function User(props: { data: LoaderData<typeof loader> }) {
  const [n, setN] = createSignal(0)
  return (
    <div>
      <h1 id="page">{props.data.user?.name}</h1>
      <button id="btn" type="button" onClick={() => setN(n() + 1)}>
        clicks: {n()}
      </button>
    </div>
  )
}
