/** @jsxImportSource preact */
import type { LoaderArgs, LoaderData } from "@nifrajs/client"
import type { backend } from "../backend"
import { Counter } from "../components/Counter"

export const meta = {
  title: "nifra — HMR (Preact)",
  meta: [{ name: "description", content: "True HMR via @nifrajs/web/vite" }],
}

// Proves SSR still runs under the Vite dev server: this value is server-rendered into the document.
export async function loader({ api }: LoaderArgs<typeof backend>) {
  const res = await api.hello.get()
  return { message: res.data?.message ?? "" }
}

// The route file co-locates loader/meta → not a Fast Refresh boundary. The view lives in <Counter>.
export default function Home(props: { data: LoaderData<typeof loader> }) {
  return <Counter message={props.data.message} />
}
