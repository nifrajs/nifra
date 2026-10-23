import { Hole } from "@nifrajs/web-solid/ppr"
import { createSignal } from "solid-js"

/** Shows the props it was given beside a click count only the component holds. */
function Tally(props: { readonly count: number }) {
  const [clicks, setClicks] = createSignal(0)
  return (
    <button type="button" onClick={() => setClicks(clicks() + 1)}>
      cart {props.count} clicked {clicks()}
    </button>
  )
}

export const tally = {
  name: "cart",
  mode: "dynamic" as const,
  interactive: true,
  render: (data: { readonly count: number }) => <Tally count={data.count} />,
}

export const inert = { ...tally, interactive: false }

interface State {
  readonly status: "pending"
  readonly ppr: true
  readonly fill?: unknown
}

export function Page(props: { readonly interactive: boolean; readonly state: State }) {
  return (
    <main>
      <Hole of={props.interactive ? tally : inert} state={props.state} />
    </main>
  )
}
