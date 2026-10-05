import { t } from "@nifrajs/schema"
import type { Route } from "./+types/index"

export const loaderOutput = t.object({ message: t.string(), count: t.number() })

export async function loader({ api }: Route.LoaderArgs) {
  const hello = await api.hello.get()
  const c = await api.count.get()
  return { message: hello.ok ? hello.data.message : "", count: c.ok ? c.data.count : 0 }
}
