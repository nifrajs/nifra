/** @jsxImportSource preact */

import { useFetcher } from "@nifrajs/web-preact/fetcher"
import { useQuery, useQueryClient } from "@nifrajs/web-preact/query"
import type { Route } from "./+types/todos"

// A keyed query for client-interactive data - distinct from the route loader. It fetches the home
// route's count (data-mode GET), caches it under ["count"], and "refresh" invalidates that key to
// refetch (showing `isFetching` over the cached value). Proves useQuery + useQueryClient on Preact.
function CountQuery() {
  const qc = useQueryClient()
  const q = useQuery(["count"], () =>
    fetch("/", { headers: { "x-nifra-data": "1" } })
      .then((r) => r.json())
      .then((d: { count: number }) => d.count),
  )
  return (
    <p id="count-query">
      home count (via useQuery): {q.isPending ? "…" : String(q.data)}
      {q.isFetching ? " (refreshing)" : ""}{" "}
      <button id="refresh-count" type="button" onClick={() => qc.invalidateQueries(["count"])}>
        refresh
      </button>
    </p>
  )
}

export const meta = {
  title: "nifra + Preact - Todos (fetchers + query)",
  meta: [{ name: "description", content: "nifra Preact bindings: useFetcher + useQuery" }],
}

// A todo row with its OWN bump fetcher. Submitting runs in an independent, concurrent state, so many
// rows can bump at once - each showing its own pending - without disturbing the list or each other.
function TodoRow(props: { todo: { id: number; text: string } }) {
  const fetcher = useFetcher(`bump-${props.todo.id}`)
  const onBump = (): void => {
    const body = new FormData()
    body.set("bump", String(props.todo.id))
    fetcher.submit("/todos", body).catch(() => {}) // fire-and-forget; the fetcher holds its own state
  }
  return (
    <li>
      {props.todo.text}{" "}
      <button
        id={`bump-${props.todo.id}`}
        type="button"
        onClick={onBump}
        disabled={fetcher.pending}
      >
        {fetcher.pending ? "bumping…" : "bump"}
      </button>
    </li>
  )
}

export default function Todos(props: Route.ComponentProps) {
  return (
    <div>
      <h1 id="page">Todos</h1>
      <CountQuery />
      <ul id="todos">
        {props.data.todos.map((todo) => (
          <TodoRow key={todo.id} todo={todo} />
        ))}
      </ul>
      <form method="post">
        <input id="text" name="text" defaultValue="" placeholder="new todo" />
        <button id="add" type="submit" disabled={props.pending}>
          add (revalidates)
        </button>
      </form>
    </div>
  )
}
