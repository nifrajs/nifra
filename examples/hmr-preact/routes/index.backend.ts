import type { LoaderArgs } from "@nifrajs/client"
import { t } from "@nifrajs/schema"
import type { backend } from "../backend/app"

export const loaderOutput = t.object({ message: t.string() })

// Proves SSR still runs under the Vite dev server: this value is server-rendered into the document.
export async function loader({ api }: LoaderArgs<typeof backend>) {
  const res = await api.hello.get()
  return { message: res.ok ? res.data.message : "" }
}
