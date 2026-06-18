import type { ActionArgs, LoaderArgs, LoaderData } from "@nifrajs/client"
import { revalidate } from "@nifrajs/web"
import { useFetcher } from "@nifrajs/web-vue/fetcher"
import { useQuery, useQueryClient } from "@nifrajs/web-vue/query"
import { defineComponent, h } from "vue"
import type { backend } from "../backend"

// A keyed query for client-interactive data — distinct from the route loader. Fetches the home count
// (data-mode GET), caches under ["count"]; "refresh" invalidates to refetch. Proves useQuery + client.
const CountQuery = defineComponent({
  name: "CountQuery",
  setup() {
    const qc = useQueryClient()
    const q = useQuery(["count"], () =>
      fetch("/", { headers: { "x-nifra-data": "1" } })
        .then((r) => r.json())
        .then((d: { count: number }) => d.count),
    )
    return () => {
      const s = q.state.value
      return h("p", { id: "count-query" }, [
        `home count (via useQuery): ${s.status === "pending" ? "…" : String(s.data)}${
          s.isFetching ? " (refreshing)" : ""
        } `,
        h(
          "button",
          { id: "refresh-count", type: "button", onClick: () => qc.invalidateQueries(["count"]) },
          "refresh",
        ),
      ])
    }
  },
})

// A todo row with its OWN bump fetcher — submitting runs in an independent, concurrent state, so many
// rows can bump at once (each showing its own pending) without disturbing the list or each other.
const TodoRow = defineComponent({
  name: "TodoRow",
  props: { todo: { required: true } },
  setup(props) {
    // `id` is stable for this instance (rows are keyed by id), so it's safe to read once. The text,
    // though, changes on revalidation — read `props.todo` INSIDE the render fn to stay reactive
    // (destructuring/capturing a prop in setup() loses Vue reactivity).
    const id = (props.todo as { id: number }).id
    const fetcher = useFetcher(`bump-${id}`)
    const onBump = (): void => {
      const body = new FormData()
      body.set("bump", String(id))
      fetcher.submit("/todos", body).catch(() => {}) // fire-and-forget; the fetcher holds its own state
    }
    return () => {
      const todo = props.todo as { id: number; text: string }
      const pending = fetcher.state.value.pending
      return h("li", null, [
        `${todo.text} `,
        h(
          "button",
          { id: `bump-${id}`, type: "button", onClick: onBump, disabled: pending },
          pending ? "bumping…" : "bump",
        ),
      ])
    }
  },
})

export const meta = {
  title: "nifra + Vue — Todos (fetchers + query)",
  meta: [{ name: "description", content: "nifra Vue bindings: useFetcher + useQuery" }],
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

export default defineComponent({
  name: "Todos",
  props: {
    data: { required: true },
    actionData: { required: false, default: undefined },
    pending: { required: false, default: false },
    submission: { required: false, default: undefined },
  },
  setup(props) {
    return () => {
      const data = props.data as LoaderData<typeof loader>
      return h("div", null, [
        h("h1", { id: "page" }, "Todos"),
        h(CountQuery),
        h(
          "ul",
          { id: "todos" },
          data.todos.map((todo) => h(TodoRow, { key: todo.id, todo })),
        ),
        h("form", { method: "post" }, [
          h("input", { id: "text", name: "text", placeholder: "new todo" }),
          h("button", { id: "add", type: "submit" }, "add (revalidates)"),
        ]),
      ])
    }
  },
})
