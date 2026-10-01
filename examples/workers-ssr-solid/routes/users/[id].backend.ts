import type { LoaderArgs } from "@nifrajs/client"
import type { backend } from "../../backend/app"

// Param route + typed loader - proves dynamic segments + data loading SSR on the edge.
export async function loader({ api, params }: LoaderArgs<typeof backend>) {
  const res = await api.users({ id: params.id ?? "" }).get()
  return { user: res.data }
}
