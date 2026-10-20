import { Hole } from "@nifrajs/web-react/ppr"

const note = {
  name: "note",
  mode: "dynamic" as const,
  render: (data: { readonly text: string }) => <p id="note">{data.text}</p>,
  fallback: <p id="note-fallback">loading note</p>,
}

export const boundaries = [note]

export default function Member(props: {
  readonly data: { readonly id: string }
  readonly boundaries?: Readonly<
    Record<string, { readonly status: "unresolved" | "pending" | "ready" | "error" }>
  >
}) {
  return (
    <main>
      <h1 id="member">member {props.data.id}</h1>
      <Hole of={note} state={props.boundaries?.note} />
    </main>
  )
}
