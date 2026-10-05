import { t } from "@nifrajs/schema"
import type { Route } from "./+types/index"

export const loaderOutput = t.object({ count: t.number() })

// Loader runs on the server (in-process during SSR). The action handles the form POST; after a
// client submit the loader revalidates with no full reload (progressive enhancement).
export async function loader({ api }: Route.LoaderArgs) {
  const res = await api.count.get()
  return { count: res.ok ? res.data.count : 0 }
}

export const actionOutput = t.object({ ok: t.boolean() })

export async function action({ api }: Route.ActionArgs) {
  await api.count.post()
  return { ok: true }
}
