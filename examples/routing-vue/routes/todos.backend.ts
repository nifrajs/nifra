import { t } from "@nifrajs/schema"
import { revalidate } from "@nifrajs/web"
import type { Route } from "./+types/todos"

export const loaderOutput = t.object({
  todos: t.array(t.object({ id: t.integer(), text: t.string() })),
})

export async function loader({ api }: Route.LoaderArgs) {
  const res = await api.todos.get()
  return { todos: res.ok ? res.data.todos : [] }
}

export const actionOutput = t.object({ ok: t.boolean() })

// On POST: a per-row "bump" (a fetcher submit) appends "!" to one todo, then declares /todos changed
// via revalidate() → the list refreshes. A plain "add" creates a todo (the active loader revalidates).
export async function action({ request, api }: Route.ActionArgs) {
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
