import type { ActionArgs, LoaderArgs } from "@nifrajs/client"
import { revalidate } from "@nifrajs/web"
import type { backend } from "../backend/app"

// The list loader - reads the current todos via the in-process api. After a client submit the loader
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
