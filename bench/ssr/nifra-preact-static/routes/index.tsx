/** @jsxImportSource preact */

import type { LoaderData } from "@nifrajs/client"
import { App } from "../../nifra-preact/app.ts"
import type { loader } from "./index.backend.ts"

export const meta = { title: "nifra SSR bench (Preact SSG)" }

export default function Index(props: { data: LoaderData<typeof loader> }) {
  return <App data={props.data} />
}
