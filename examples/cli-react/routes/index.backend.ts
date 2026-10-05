import { t } from "@nifrajs/schema"
import type { Route } from "./+types/index"

export const loaderOutput = t.object({ message: t.string() })

export async function loader({ api }: Route.LoaderArgs) {
  const res = await api.hello.get()
  return { message: res.ok ? res.data.message : "" }
}
