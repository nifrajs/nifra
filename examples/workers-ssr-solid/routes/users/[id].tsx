import type { MetaArgs } from "@nifrajs/web"
import { createSignal } from "solid-js"
import type { Route } from "./+types/[id]"

export function meta({ data }: MetaArgs<Route.LoaderData>) {
  return { title: data.user ? `User #${data.user.id}` : "User" }
}

export default function User(props: Route.ComponentProps) {
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
