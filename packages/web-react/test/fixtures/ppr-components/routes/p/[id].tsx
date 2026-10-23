import type { BoundaryStates } from "@nifrajs/web"
import { serverHole } from "@nifrajs/web/server-components/hole"
import { Hole } from "@nifrajs/web-react/ppr"
import { Summary } from "../../Summary.component.server.tsx"

const summary = {
  name: "summary",
  mode: "dynamic" as const,
  render: serverHole(Summary),
  fallback: <p id="summary-fallback">loading the basket</p>,
}

export const boundaries = [summary]

export default function Product(props: {
  readonly data: { readonly title: string }
  readonly boundaries?: BoundaryStates
}) {
  return (
    <main>
      <h1 id="title">{props.data.title}</h1>
      <p>
        Every visitor gets this text from the shared shell at once. The basket below is one
        visitor's: a server component renders it on the server for each request, and only the button
        inside it, a client island, ever reaches the browser as code.
      </p>
      <Hole of={summary} state={props.boundaries?.summary} />
      <form method="post">
        <button id="add" type="submit">
          Add one
        </button>
      </form>
    </main>
  )
}
