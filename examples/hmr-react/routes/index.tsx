import type { LoaderArgs, LoaderData } from "@nifrajs/client"
import type { backend } from "../backend"
import { Counter } from "../components/Counter"

export const meta = {
  title: "nifra — HMR (React)",
  meta: [{ name: "description", content: "True HMR via @nifrajs/web/vite" }],
}

// Proves SSR still runs under the Vite dev server: this value is server-rendered into the document.
export async function loader({ api }: LoaderArgs<typeof backend>) {
  const res = await api.hello.get()
  return { message: res.data?.message ?? "" }
}

// The route file co-locates loader/meta (server contract) → not a Fast Refresh boundary. The view
// lives in <Counter> (a component-only module) so editing the UI HMR-swaps with state preserved.
export default function Home(props: { data: LoaderData<typeof loader> }) {
  return <Counter message={props.data.message} />
}
