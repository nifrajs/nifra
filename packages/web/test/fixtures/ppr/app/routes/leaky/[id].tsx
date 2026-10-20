const note = {
  name: "note",
  mode: "dynamic" as const,
  render: (data: { readonly text: string }) => <p id="note">{data.text}</p>,
  fallback: <p>loading note</p>,
}
export const boundaries = [note]

export default function Leaky(props: { readonly data: { readonly who: string } }) {
  return <h1 id="leaky">{props.data.who}</h1>
}
