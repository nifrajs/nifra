import { t } from "@nifrajs/schema"
import type { Route } from "./+types/index"

export const loaderOutput = t.object({ count: t.number() })

export async function loader({ api }: Route.LoaderArgs) {
  const res = await api.count.get()
  return { count: res.ok ? res.data.count : 0 }
}

export const actionOutput = t.object({ ok: t.boolean() })

export async function action({ api }: Route.ActionArgs) {
  await api.count.post() // the client submit revalidates the loader → count updates, no full reload
  return { ok: true }
}
