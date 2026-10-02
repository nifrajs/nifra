import type { LoaderArgs } from "@nifrajs/client"
import { t } from "@nifrajs/schema"
import type { backend } from "../backend/app"

export const loaderOutput = t.object({ message: t.string(), count: t.number() })

export async function loader({ api }: LoaderArgs<typeof backend>) {
  const hello = await api.hello.get()
  const c = await api.count.get()
  return { message: hello.data?.message ?? "", count: c.data?.count ?? 0 }
}
