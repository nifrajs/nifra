import type { LoaderData } from "@nifrajs/client"
import { h } from "vue"
import { App } from "../../nifra-vue/app.ts"
import type { loader } from "./index.backend.ts"

export const meta = { title: "nifra SSR bench (Vue SSG)" }

export default function Index(props: { data: LoaderData<typeof loader> }) {
  // This is a Vue benchmark route. JSX without a Vue JSX runtime creates a framework-agnostic
  // object, which Vue SSR serializes as `[object Object]` instead of rendering the component tree.
  return h(App, { data: props.data })
}
