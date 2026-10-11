import { createReactComponentRenderer } from "@nifrajs/web-react/server-components/rsc"
import { Child } from "./Child.component.server"
import { Summary } from "./Summary.component.server"
export const render = createReactComponentRenderer([Summary, Child])
export default async function handler(request: Request) {
  const ssr = await import.meta.viteRsc.loadModule<typeof import("./entry-ssr.backend")>(
    "ssr",
    "index",
  )
  return ssr.default(request)
}
