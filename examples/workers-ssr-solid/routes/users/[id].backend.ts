import { t } from "@nifrajs/schema"
import type { Route } from "./+types/[id]"

export const loaderOutput = t.object({
  user: t.optional(t.object({ id: t.string(), name: t.string() })),
})

// Param route + typed loader - proves dynamic segments + data loading SSR on the edge.
export async function loader({ api, params }: Route.LoaderArgs) {
  const res = await api.users({ id: params.id }).get()
  return { user: res.ok ? res.data : undefined }
}
