import type { LoaderArgs } from "@nifrajs/client"
import { t } from "@nifrajs/schema"
import type { GetStaticPaths } from "@nifrajs/web"
import type { backend } from "../../backend/app"

// SSG dynamic route: enumerate which user pages to prerender at build (build.ts → prerenderRoutes
// writes users/1/index.html, users/2/index.html, users/7/index.html). `fallback: "ssr"` (default)
// means any OTHER id (e.g. /users/99) still renders on-demand via the worker in a hybrid deploy.
export const getStaticPaths: GetStaticPaths = async () => ({
  paths: [{ params: { id: "1" } }, { params: { id: "2" } }, { params: { id: "7" } }],
})

export const loaderOutput = t.object({
  user: t.optional(t.object({ id: t.string(), name: t.string() })),
})

// Same typed loader as the Solid example - only the component differs (agnostic data layer).
export async function loader({ api, params }: LoaderArgs<typeof backend>) {
  const res = await api.users({ id: params.id ?? "" }).get()
  return { user: res.ok ? res.data : undefined }
}
