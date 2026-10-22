import { Hole } from "@nifrajs/web-react/ppr"
import { type ReactNode, useState } from "react"

/** The server's count beside a click count only the hole's own root holds. */
function Basket(props: { readonly count: number }): ReactNode {
  const [clicks, setClicks] = useState(0)
  return (
    <button id="basket" type="button" onClick={() => setClicks(clicks + 1)}>
      basket {props.count} clicked {clicks}
    </button>
  )
}

const basket = {
  name: "basket",
  mode: "dynamic" as const,
  interactive: true,
  render: (data: { readonly count: number }) => <Basket count={data.count} />,
  fallback: <p id="basket-fallback">loading basket</p>,
}
const note = {
  name: "note",
  mode: "dynamic" as const,
  render: (data: { readonly count: number }) => <p id="note">note {data.count}</p>,
  fallback: <p id="note-fallback">loading note</p>,
}

export const boundaries = [basket, note]

type BoundaryStates = Readonly<
  Record<
    string,
    { readonly status: "unresolved" | "pending" | "ready" | "error"; readonly ppr?: true }
  >
>

export default function CartPage(props: {
  readonly data: { readonly title: string }
  readonly boundaries?: BoundaryStates
}) {
  return (
    <main>
      <h1 id="title">{props.data.title}</h1>
      <Hole of={basket} state={props.boundaries?.basket} />
      <Hole of={note} state={props.boundaries?.note} />
      <form method="post">
        <button id="add" type="submit">
          add
        </button>
      </form>
    </main>
  )
}
