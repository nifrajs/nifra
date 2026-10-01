import type { LoaderData } from "@nifrajs/client"
import { Counter } from "../frontend/components/Counter"
import type { loader } from "./index.backend.ts"

export const meta = {
  title: "nifra - CLI demo",
  meta: [{ name: "description", content: "Driven entirely by the nifra CLI (zero-config)." }],
}

export default function Home(props: { data: LoaderData<typeof loader> }) {
  return <Counter message={props.data.message} />
}
