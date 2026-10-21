import { t } from "@nifrajs/schema"
import { votes } from "../backend/votes"
import type { Route } from "./+types/index"

export const loaderOutput = t.object({ bun: t.number(), deno: t.number(), node: t.number() })

export async function loader({ live }: Route.LoaderArgs) {
  // Every tab showing this page reloads this data when `votes` is published.
  live("votes")
  return votes()
}
