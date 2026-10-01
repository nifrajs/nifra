import type { LoaderData } from "@nifrajs/client"
import { Counter } from "../frontend/components/Counter"
import type { loader } from "./index.backend.ts"

export const meta = {
  title: "nifra - HMR (React)",
  meta: [{ name: "description", content: "True HMR via @nifrajs/web/vite" }],
}

// The route file co-locates loader/meta (server contract) → not a Fast Refresh boundary. The view
// lives in <Counter> (a component-only module) so editing the UI HMR-swaps with state preserved.
export default function Home(props: { data: LoaderData<typeof loader> }) {
  return <Counter message={props.data.message} />
}
