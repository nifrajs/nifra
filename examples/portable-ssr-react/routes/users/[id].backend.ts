import type { LoaderArgs } from "@nifrajs/client"
import type { backend } from "../../backend/app"

export async function loader({ api, params }: LoaderArgs<typeof backend>) {
  const res = await api.users({ id: params.id ?? "" }).get()
  return { user: res.data }
}
