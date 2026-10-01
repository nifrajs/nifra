import type { LoaderArgs } from "@nifrajs/client"
import type { backend } from "../backend/app"

export async function loader({ api }: LoaderArgs<typeof backend>) {
  const hello = await api.hello.get()
  const c = await api.count.get()
  return { message: hello.data?.message ?? "", count: c.data?.count ?? 0 }
}
