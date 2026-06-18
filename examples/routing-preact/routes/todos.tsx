/** @jsxImportSource preact */
import type { ActionArgs, LoaderArgs, LoaderData } from "@nifrajs/client"
import { revalidate } from "@nifrajs/web"
import { useFetcher } from "@nifrajs/web-preact/fetcher"
import { useQuery, useQueryClient } from "@nifrajs/web-preact/query"
import type { backend } from "../backend"

// A keyed query for client-interactive data — distinct from the route loader. It fetches the home
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
  title: "nifra + Preact — Todos (fetchers + query)",
  meta: [{ name: "description", content: "nifra Preact bindings: useFetcher + useQuery" }],
}

export async function loader({ api }: LoaderArgs<typeof backend>) {
  const res = await api.todos.get()
  return { todos: res.data?.todos ?? [] }
}

// On POST: a per-row "bump" (a fetcher submit) appends "!" to one todo, then declares /todos changed
// via revalidate() → the list refreshes. A plain "add" creates a todo (the active loader revalidates).
export async function action({ request, api }: ActionArgs<typeof backend>) {
  const form = await request.formData()
  const bumpId = form.get("bump")
  if (typeof bumpId === "string" && bumpId !== "") {
    await new Promise<void>((resolve) => setTimeout(resolve, 500)) // slow → pending visible
    await api.todos.bump.post({ id: Number(bumpId) })
    return revalidate(["/todos"], { ok: true as const })
  }
  const raw = form.get("text")
  const text = typeof raw === "string" ? raw.trim() : ""
  if (text === "") return { ok: false as const }
  await api.todos.post({ text })
  return { ok: true as const }
}

// A todo row with its OWN bump fetcher. Submitting runs in an independent, concurrent state, so many
// rows can bump at once — each showing its own pending — without disturbing the list or each other.
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

export default function Todos(props: { data: LoaderData<typeof loader>; pending?: boolean }) {
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
