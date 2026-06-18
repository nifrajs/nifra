import type { LoaderArgs, LoaderData } from "@nifrajs/client"
import type { GetStaticPaths, MetaArgs } from "@nifrajs/web"
import { useState } from "react"
import type { backend } from "../../backend"

// SSG dynamic route: enumerate which user pages to prerender at build (build.ts → prerenderRoutes
// writes users/1/index.html, users/2/index.html, users/7/index.html). `fallback: "ssr"` (default)
// means any OTHER id (e.g. /users/99) still renders on-demand via the worker in a hybrid deploy.
export const getStaticPaths: GetStaticPaths = async () => ({
  paths: [{ params: { id: "1" } }, { params: { id: "2" } }, { params: { id: "7" } }],
})

// Same typed loader as the Solid example — only the component differs (agnostic data layer).
export async function loader({ api, params }: LoaderArgs<typeof backend>) {
  const res = await api.users({ id: params.id ?? "" }).get()
  return { user: res.data }
}

// Dynamic head — a function of the loader data. Updates the title on client navigation.
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
