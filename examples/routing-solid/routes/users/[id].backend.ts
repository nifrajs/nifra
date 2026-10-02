import type { LoaderArgs } from "@nifrajs/client"
import { t } from "@nifrajs/schema"
import type { backend } from "../../backend/app"

export const loaderOutput = t.object({
  user: t.optional(t.object({ id: t.string(), name: t.string() })),
})

// Typed via the annotation. `ctx.api` is the typed in-process client; the return flows to the page's
// `data` prop via LoaderData.
export async function loader({ api, params }: LoaderArgs<typeof backend>) {
  const res = await api.users({ id: params.id ?? "" }).get()
  return { user: res.data }
}
