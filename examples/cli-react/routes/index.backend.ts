import type { LoaderArgs } from "@nifrajs/client"
import { t } from "@nifrajs/schema"
import type { backend } from "../backend/app"

export const loaderOutput = t.object({ message: t.string() })

export async function loader({ api }: LoaderArgs<typeof backend>) {
  const res = await api.hello.get()
  return { message: res.data?.message ?? "" }
}
