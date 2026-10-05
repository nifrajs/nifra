import { t } from "@nifrajs/schema"
import type { Route } from "./+types/index"

export const loaderOutput = t.object({ count: t.number() })

// Typed loader + action against the contract - the SAME code that runs on Bun/Node/Deno, now on
// workerd. The loader reads the count; the action increments it. After a client submit the loader
// revalidates (no full reload); with JS off the native POST re-renders (progressive enhancement).
export async function loader({ api }: Route.LoaderArgs) {
  const res = await api.count.get()
  return { count: res.ok ? res.data.count : 0 }
}

export const actionOutput = t.object({ ok: t.boolean() })

export async function action({ api }: Route.ActionArgs) {
  await api.count.post()
  return { ok: true }
}
