import type { ActionArgs, LoaderArgs } from "@nifrajs/client"
import type { backend } from "../backend/app"

export async function loader({ api }: LoaderArgs<typeof backend>) {
  const res = await api.count.get()
  return { count: res.data?.count ?? 0 }
}

export async function action({ api }: ActionArgs<typeof backend>) {
  await api.count.post() // the client submit revalidates the loader → count updates, no full reload
  return { ok: true }
}
