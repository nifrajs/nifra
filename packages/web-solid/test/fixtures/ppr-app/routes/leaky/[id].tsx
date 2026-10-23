import type { BoundaryStates } from "@nifrajs/web"
import { Hole } from "@nifrajs/web-solid/ppr"

const note = {
  name: "note",
  mode: "dynamic" as const,
  render: (data: { readonly text: string }) => <p id="note">{data.text}</p>,
  fallback: () => <p>loading note</p>,
}
export const boundaries = [note]

export default function Leaky(props: {
  readonly data: { readonly who: string }
  readonly boundaries?: BoundaryStates
}) {
  return (
    <main>
      <h1 id="leaky">{props.data.who}</h1>
      <Hole of={note} state={props.boundaries?.note} />
    </main>
  )
}
