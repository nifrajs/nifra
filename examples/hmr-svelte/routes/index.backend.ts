import { t } from "@nifrajs/schema"
export const loaderOutput = t.object({ message: t.string() })

// Proves SSR still runs under the Vite dev server: this value is server-rendered into the document.
export async function loader({ api }) {
  const res = await api.hello.get()
  return { message: res.ok ? res.data.message : "" }
}
