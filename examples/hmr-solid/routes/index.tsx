import { Counter } from "../frontend/components/Counter"
import type { Route } from "./+types/index"

export const meta = {
  title: "nifra - HMR (Solid)",
  meta: [{ name: "description", content: "True HMR via @nifrajs/web/vite" }],
}

// The route file co-locates loader/meta → not a Fast Refresh boundary. The view lives in <Counter>.
export default function Home(props: Route.ComponentProps) {
  return <Counter message={props.data.message} />
}
