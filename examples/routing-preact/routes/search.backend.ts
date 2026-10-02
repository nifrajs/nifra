import type { LoaderArgs } from "@nifrajs/client"
import { t } from "@nifrajs/schema"
import type { backend } from "../backend/app"
import type { searchSchema } from "../shared/search.ts"

export const loaderOutput = t.object({ echoed: t.string() })

export async function loader({ search }: LoaderArgs<typeof backend, unknown, typeof searchSchema>) {
  return { echoed: `${search.page}:${search.q}` }
}
