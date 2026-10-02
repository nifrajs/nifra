import { t } from "@nifrajs/schema"
import type { Route } from "./+types/[id]"

export const loaderOutput = t.object({
  user: t.optional(t.object({ id: t.string(), name: t.string() })),
})

// Typed via the annotation. `ctx.api` is the typed in-process client; the return reaches the page's
// `data` prop through `loaderOutput`, which is what `Route.ComponentProps` types it as.
export async function loader({ api, params }: Route.LoaderArgs) {
  const res = await api.users({ id: params.id }).get()
  return { user: res.ok ? res.data : undefined }
}
