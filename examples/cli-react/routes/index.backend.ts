import type { LoaderArgs } from "@nifrajs/client"
import type { backend } from "../backend/app"

export async function loader({ api }: LoaderArgs<typeof backend>) {
  const res = await api.hello.get()
  return { message: res.data?.message ?? "" }
}
