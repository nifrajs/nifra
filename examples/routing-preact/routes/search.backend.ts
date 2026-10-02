import { t } from "@nifrajs/schema"
import type { Route } from "./+types/search"

export const loaderOutput = t.object({ echoed: t.string() })

export async function loader({ search }: Route.LoaderArgs) {
  return { echoed: `${search.page}:${search.q}` }
}
