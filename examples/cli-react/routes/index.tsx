import type { LoaderArgs, LoaderData } from "@nifrajs/client"
import type { backend } from "../backend"
import { Counter } from "../components/Counter"

export const meta = {
  title: "nifra — CLI demo",
  meta: [{ name: "description", content: "Driven entirely by the nifra CLI (zero-config)." }],
}

export async function loader({ api }: LoaderArgs<typeof backend>) {
  const res = await api.hello.get()
  return { message: res.data?.message ?? "" }
}

export default function Home(props: { data: LoaderData<typeof loader> }) {
  return <Counter message={props.data.message} />
}
