import { useFetcher } from "@nifrajs/web-vue/fetcher"
import { useQuery, useQueryClient } from "@nifrajs/web-vue/query"
import { defineComponent, h } from "vue"
import type { Route } from "./+types/todos"

// A keyed query for client-interactive data - distinct from the route loader. Fetches the home count
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

// A todo row with its OWN bump fetcher - submitting runs in an independent, concurrent state, so many
// rows can bump at once (each showing its own pending) without disturbing the list or each other.
const TodoRow = defineComponent(
  (props: { todo: Route.LoaderData["todos"][number] }) => {
    // `id` is stable for this instance (rows are keyed by id), so it's safe to read once. The text,
    // though, changes on revalidation - read `props.todo` INSIDE the render fn to stay reactive
    // (destructuring/capturing a prop in setup() loses Vue reactivity).
    const id = props.todo.id
    const fetcher = useFetcher(`bump-${id}`)
    const onBump = (): void => {
      const body = new FormData()
      body.set("bump", String(id))
      fetcher.submit("/todos", body).catch(() => {}) // fire-and-forget; the fetcher holds its own state
    }
    return () => {
      const pending = fetcher.state.value.pending
      return h("li", null, [
        `${props.todo.text} `,
        h(
          "button",
          { id: `bump-${id}`, type: "button", onClick: onBump, disabled: pending },
          pending ? "bumping…" : "bump",
        ),
      ])
    }
  },
  { name: "TodoRow", props: ["todo"] },
)

export const meta = {
  title: "nifra + Vue - Todos (fetchers + query)",
  meta: [{ name: "description", content: "nifra Vue bindings: useFetcher + useQuery" }],
}

export default defineComponent(
  (props: Route.ComponentProps) => () =>
    h("div", null, [
      h("h1", { id: "page" }, "Todos"),
      h(CountQuery),
      h(
        "ul",
        { id: "todos" },
        props.data.todos.map((todo) => h(TodoRow, { key: todo.id, todo })),
      ),
      h("form", { method: "post" }, [
        h("input", { id: "text", name: "text", placeholder: "new todo" }),
        h("button", { id: "add", type: "submit" }, "add (revalidates)"),
      ]),
    ]),
  { name: "Todos", props: ["data", "actionData", "pending", "submission"] },
)
