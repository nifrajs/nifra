import { t } from "@nifrajs/schema"
import type { Route } from "./+types/index"

export const loaderOutput = t.object({ count: t.number() })

// Loader runs on the server (in-process during SSR). The action handles the form POST; after a
// client submit the loader revalidates with no full reload (progressive enhancement).
// Route.Loader and Route.Action check what each returns against its output schema.
export const loader: Route.Loader = async ({ api }) => {
  const res = await api.count.get()
  return { count: res.ok ? res.data.count : 0 }
}

export const actionOutput = t.object({ ok: t.boolean() })

export const action: Route.Action = async ({ api }) => {
  await api.count.post()
  return { ok: true }
}
