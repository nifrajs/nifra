import { Hole } from "@nifrajs/web-react/ppr"
import { type ReactNode, useState } from "react"

function Cart(props: { readonly count: number }): ReactNode {
  const [count, setCount] = useState(props.count)
  return (
    <button id="cart" type="button" onClick={() => setCount(count + 1)}>
      cart {count}
    </button>
  )
}

const greeting = {
  name: "greeting",
  mode: "dynamic" as const,
  render: (data: { readonly name: string }) => <p id="greeting">hello {data.name}</p>,
  fallback: <p id="greeting-fallback">loading greeting</p>,
}
const cart = {
  name: "cart",
  mode: "dynamic" as const,
  interactive: true,
  render: (data: { readonly count: number }) => <Cart count={data.count} />,
  fallback: <p id="cart-fallback">loading cart</p>,
}
const slow = {
  name: "slow",
  mode: "dynamic" as const,
  render: (data: { readonly at: number }) => <p id="slow">slow {data.at}</p>,
  fallback: <p id="slow-fallback">loading slow</p>,
}

export const boundaries = [greeting, cart, slow]

export const meta = (args: {
  readonly origin: string
  readonly params: Readonly<Record<string, string>>
}) => ({ link: [{ rel: "canonical", href: `${args.origin}/p/${args.params.id}` }] })

type BoundaryStates = Readonly<
  Record<
    string,
    {
      readonly status: "unresolved" | "pending" | "ready" | "error"
      readonly data?: unknown
      readonly ppr?: true
    }
  >
>

export default function Product(props: {
  readonly data: { readonly title: string }
  readonly boundaries?: BoundaryStates
}) {
  return (
    <main>
      <h1 id="title">{props.data.title}</h1>
      <Hole of={greeting} state={props.boundaries?.greeting} />
      <Hole of={cart} state={props.boundaries?.cart} />
      <Hole of={slow} state={props.boundaries?.slow} />
    </main>
  )
}
