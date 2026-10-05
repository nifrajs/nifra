import { Counter } from "../frontend/components/Counter"
import type { Route } from "./+types/index"

export const meta = {
  title: "nifra - CLI demo",
  meta: [{ name: "description", content: "Driven entirely by the nifra CLI (zero-config)." }],
}

export default function Home(props: Route.ComponentProps) {
  return <Counter message={props.data.message} />
}
