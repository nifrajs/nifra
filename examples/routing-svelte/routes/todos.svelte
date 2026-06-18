<!--
  Todos route — exercises the Svelte bindings: useQuery + useQueryClient (the count panel) and
  useFetcher (the bump button). The bindings are Svelte stores, read reactively with `$` (top-level
  vars only — that's why the bump is a single top-level fetcher, not per-row).
-->
<script module>
  import { revalidate } from "@nifrajs/web"

  export const meta = {
    title: "nifra + Svelte — Todos (fetchers + query)",
    meta: [{ name: "description", content: "nifra Svelte bindings: useFetcher + useQuery" }],
  }

  export async function loader({ api }) {
    const res = await api.todos.get()
    return { todos: res.data?.todos ?? [] }
  }

  export async function action({ request, api }) {
    const form = await request.formData()
    const bumpId = form.get("bump")
    if (typeof bumpId === "string" && bumpId !== "") {
      await new Promise((resolve) => setTimeout(resolve, 500)) // slow → pending visible
      await api.todos.bump.post({ id: Number(bumpId) })
      return revalidate(["/todos"], { ok: true })
    }
    const raw = form.get("text")
    const text = typeof raw === "string" ? raw.trim() : ""
    if (text === "") return { ok: false }
    await api.todos.post({ text })
    return { ok: true }
  }
</script>

<script>
  import { useFetcher } from "@nifrajs/web-svelte/fetcher"
  import { useQuery, useQueryClient } from "@nifrajs/web-svelte/query"
  let { data } = $props()

  const qc = useQueryClient()
  // A keyed query for the home count (data-mode GET), distinct from this route's loader. Read via `$`.
  const count = useQuery(["count"], () =>
    fetch("/", { headers: { "x-nifra-data": "1" } })
      .then((r) => r.json())
      .then((d) => d.count),
  )

  // A concurrent fetcher: bumps todo #1 (appends "!"), then revalidate() refreshes the list. Read via `$`.
  const bump = useFetcher("bump-1")
  function onBump() {
    const body = new FormData()
    body.set("bump", "1")
    bump.submit("/todos", body).catch(() => {})
  }
</script>

<div>
  <h1 id="page">Todos</h1>
  <p id="count-query">
    home count (via useQuery): {$count.status === "pending" ? "…" : $count.data}{$count.isFetching
      ? " (refreshing)"
      : ""}
    <button id="refresh-count" type="button" onclick={() => qc.invalidateQueries(["count"])}
      >refresh</button
    >
  </p>
  <ul id="todos">
    {#each data.todos as todo (todo.id)}
      <li>{todo.text}</li>
    {/each}
  </ul>
  <button id="bump" type="button" disabled={$bump.pending} onclick={onBump}
    >{$bump.pending ? "bumping…" : "bump first"}</button
  >
  <form method="post">
    <input id="text" name="text" placeholder="new todo" />
    <button id="add" type="submit">add (revalidates)</button>
  </form>
</div>
