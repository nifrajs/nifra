import type { ActionArgs, LoaderArgs } from "@nifrajs/client"
import type { backend } from "../backend/app"

// The SAME typed loader + action as the React example (agnostic data layer) - now SSR'd by Solid on
// workerd. The loader reads the count; the action increments it; a client submit revalidates the
// loader (no reload), and with JS off the native POST re-renders (progressive enhancement).
export async function loader({ api }: LoaderArgs<typeof backend>) {
  const res = await api.count.get()
  return { count: res.data?.count ?? 0 }
}

export async function action({ api }: ActionArgs<typeof backend>) {
  await api.count.post()
  return { ok: true }
}
