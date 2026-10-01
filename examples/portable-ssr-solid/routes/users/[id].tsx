import type { LoaderData } from "@nifrajs/client"
import type { MetaArgs } from "@nifrajs/web"
import { createSignal } from "solid-js"
import type { loader } from "./[id].backend.ts"

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
