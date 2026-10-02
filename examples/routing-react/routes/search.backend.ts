import type { LoaderArgs } from "@nifrajs/client"
import { t } from "@nifrajs/schema"
import type { backend } from "../backend/app"
import type { searchSchema } from "../shared/search.ts"

// A loader-run counter, so the page can show whether the loader actually re-ran: a client-only `?view`
// change leaves it unchanged, a `?page` change bumps it.
let loaderRuns = 0

export const loaderOutput = t.object({ echoed: t.string(), run: t.integer() })

// The loader reads the validated query as `ctx.search` (typed by the third LoaderArgs arg), never by
// parsing the URL itself. `search.page` is a number here.
export async function loader({ search }: LoaderArgs<typeof backend, unknown, typeof searchSchema>) {
  loaderRuns++
  return { echoed: `${search.page}:${search.q}`, run: loaderRuns }
}
