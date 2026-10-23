import { Hole } from "@nifrajs/web-react/ppr"

const price = {
  name: "price",
  mode: "shared" as const,
  render: (data: { readonly amount: number }) => <p id="price">price {data.amount}</p>,
  fallback: <p id="price-fallback">loading price</p>,
}
const greeting = {
  name: "greeting",
  mode: "dynamic" as const,
  render: (data: { readonly name: string }) => <p id="greeting">hello {data.name}</p>,
  fallback: <p id="greeting-fallback">loading greeting</p>,
}

export const boundaries = [price, greeting]

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

export default function Stock(props: {
  readonly data: { readonly title: string }
  readonly boundaries?: BoundaryStates
}) {
  return (
    <main>
      <h1 id="title">{props.data.title}</h1>
      <Hole of={price} state={props.boundaries?.price} />
      <Hole of={greeting} state={props.boundaries?.greeting} />
      <a id="to-s9" href="/s/9">
        next
      </a>
    </main>
  )
}
