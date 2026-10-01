import { revalidate } from "@nifrajs/web"

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
