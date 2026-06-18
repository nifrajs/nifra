import type { LoaderArgs, LoaderData } from "@nifrajs/client"
import type { MetaArgs } from "@nifrajs/web"
import { useState } from "react"
import type { backend } from "../../backend"

// Param route + typed loader — proves dynamic segments + data loading SSR on the edge.
export async function loader({ api, params }: LoaderArgs<typeof backend>) {
  const res = await api.users({ id: params.id ?? "" }).get()
  return { user: res.data }
}

export function meta({ data }: MetaArgs<LoaderData<typeof loader>>) {
  return { title: data.user ? `User #${data.user.id}` : "User" }
}

export default function User(props: { data: LoaderData<typeof loader> }) {
  const [n, setN] = useState(0)
  return (
    <div>
      <h1 id="page">{props.data.user?.name}</h1>
      <button id="btn" type="button" onClick={() => setN((c) => c + 1)}>
        clicks: {n}
      </button>
    </div>
  )
}
