import { t } from "@nifrajs/schema"
import type { Route } from "./+types/[id]"

export const loaderOutput = t.object({
  user: t.optional(t.object({ id: t.string(), name: t.string() })),
})

export async function loader({ api, params }: Route.LoaderArgs) {
  const res = await api.users({ id: params.id }).get()
  return { user: res.ok ? res.data : undefined }
}
