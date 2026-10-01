import type { LoaderData } from "@nifrajs/client"
import { App } from "../../nifra-solid/app.tsx"
import type { loader } from "./index.backend.ts"

export const meta = { title: "nifra SSR bench (Solid SSG)" }

export default function Index(props: { data: LoaderData<typeof loader> }) {
  return <App data={props.data} />
}
