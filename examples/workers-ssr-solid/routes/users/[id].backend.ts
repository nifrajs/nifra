import type { LoaderArgs } from "@nifrajs/client"
import { t } from "@nifrajs/schema"
import type { backend } from "../../backend/app"

export const loaderOutput = t.object({
  user: t.optional(t.object({ id: t.string(), name: t.string() })),
})

// Param route + typed loader - proves dynamic segments + data loading SSR on the edge.
export async function loader({ api, params }: LoaderArgs<typeof backend>) {
  const res = await api.users({ id: params.id ?? "" }).get()
  return { user: res.data }
}
