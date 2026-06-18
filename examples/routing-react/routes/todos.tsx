import type { ActionArgs, ActionData, LoaderArgs, LoaderData } from "@nifrajs/client"
import { revalidate, type Submission } from "@nifrajs/web"
import { useFetcher } from "@nifrajs/web-react/fetcher"
import { useQuery, useQueryClient } from "@nifrajs/web-react/query"
import type { backend } from "../backend"

// F16 (query-cache): a keyed query for client-interactive data — distinct from the route loader. It
// fetches the home route's count (data-mode GET), caches it under ["count"], and the "refresh" button
// invalidates that key to refetch (showing `isFetching` over the cached value). Two such panels would
// share one cache entry + one fetch (dedup). Loaders stay the SSR data source; queries are client-first.
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

// Static head for this route — SSR-injected + updated on client navigation.
export const meta = {
  title: "nifra — Todos (optimistic UI + fetchers)",
  meta: [{ name: "description", content: "nifra F15/F16 optimistic UI + revalidation + fetchers" }],
}

// The list loader — reads the current todos via the in-process api. After a client submit the loader
// REVALIDATES (unless the form opts out), so the reconciled list reflects what the server accepted.
export async function loader({ api }: LoaderArgs<typeof backend>) {
  const res = await api.todos.get()
  return { todos: res.data?.todos ?? [] }
}

// The mutation handles two flows on POST /todos:
//   • per-row "bump" (a fetcher submit, F16): append "!" to one todo, then declare /todos changed via
//     revalidate() → X-Nifra-Revalidate, so the list (and any other mounted view of it) refreshes.
//   • "add" (a form submit, F15): the optimistic-UI + revalidation-control demo. Returns a typed
//     error for the reject case (a 200, so no native fallback) and the created todo as actionData.
// Both are artificially slow so their in-flight states are observable.
export async function action({ request, api }: ActionArgs<typeof backend>) {
  const form = await request.formData()

  const bumpId = form.get("bump")
  if (typeof bumpId === "string" && bumpId !== "") {
    await new Promise<void>((resolve) => setTimeout(resolve, 900)) // slow → concurrent pending visible
    await api.todos.bump.post({ id: Number(bumpId) })
    return revalidate(["/todos"], { ok: true as const, created: null })
  }

  const raw = form.get("text")
  const text = typeof raw === "string" ? raw.trim() : ""
  await new Promise<void>((resolve) => setTimeout(resolve, 700))
  if (text === "" || text === "fail") return { ok: false as const, error: "rejected" as const }
  const res = await api.todos.post({ text })
  if (res.error || res.data === undefined) return { ok: false as const, error: "rejected" as const }
  return { ok: true as const, created: res.data.todo }
}

// A todo row with its OWN bump fetcher (F16). Submitting runs in an independent, concurrent state, so
// many rows can be bumping at once — each showing its own pending — without disturbing the list, the
// add form, or each other. The bump action declares /todos changed, so the list refreshes per bump.
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

export default function Todos(props: {
  data: LoaderData<typeof loader>
  actionData?: ActionData<typeof action>
  pending?: boolean
  submission?: Submission
}) {
  // F15: the in-flight submission drives the OPTIMISTIC row — rendered instantly from the FormData
  // the client just submitted, before the server has responded. `formData.get` may return a File, so
  // narrow to string. Cleared automatically when the submit settles (then the real data shows).
  const optimistic = props.submission?.formData.get("text")
  const optimisticText = typeof optimistic === "string" ? optimistic : null

  // Revalidation control: when a submit opts OUT of revalidation (data-nifra-revalidate="false"), the
  // loader data stays stale, so we surface the created todo from actionData instead — deduped against
  // the list so the revalidating form (whose reconcile already includes it) never double-renders.
  const created = props.actionData?.ok ? props.actionData.created : null
  const createdIsNew = created !== null && !props.data.todos.some((todo) => todo.id === created.id)

  return (
    <div>
      <h1 id="page">Todos</h1>
      <CountQuery />
      <p>
        Add an item (optimistic → reconcile → revert), or <strong>bump</strong> rows: each bump runs
        in its own fetcher, so many rows mutate at once without blocking the list or the form.
      </p>
      <ul id="todos">
        {props.data.todos.map((todo) => (
          <TodoRow key={todo.id} todo={todo} />
        ))}
        {/* A todo added via the no-revalidate form: shown from actionData (no full-list re-fetch). */}
        {createdIsNew && created !== null ? (
          <li key={created.id} id="from-action">
            {created.text}
          </li>
        ) : null}
        {/* The optimistic row — only present while a submit is in flight. */}
        {optimisticText !== null ? (
          <li id="optimistic" style={{ opacity: 0.5 }}>
            {optimisticText} (saving…)
          </li>
        ) : null}
      </ul>
      {/* On a rejected submit the action returns a typed error (no item added → optimistic reverts). */}
      {props.actionData && !props.actionData.ok ? (
        <p id="error" role="alert">
          couldn't add that — try different text (not empty, not "fail")
        </p>
      ) : null}

      {/* Default form: after the action, the active loader REVALIDATES, so the list re-reads. */}
      <form method="post">
        <input id="text" name="text" defaultValue="" placeholder='new todo (try "fail")' />
        <button id="add" type="submit" disabled={props.pending}>
          add (revalidates)
        </button>
      </form>

      {/* Opt-out form: data-nifra-revalidate="false" SKIPS the post-action loader fetch — the new row
          is shown from the action's returned `created` (above) instead of a full-list re-read. */}
      <form method="post" data-nifra-revalidate="false">
        <input
          id="text-no-reval"
          name="text"
          defaultValue=""
          placeholder="new todo (no revalidate)"
        />
        <button id="add-no-reval" type="submit" disabled={props.pending}>
          add (skips revalidation)
        </button>
      </form>
    </div>
  )
}
