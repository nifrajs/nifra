import type { Route } from "./+types/index"

export const meta = { title: "nifra - portable SSR" }

export default function Home(props: Route.ComponentProps) {
  return (
    <div>
      <h1 id="page">Home</h1>
      <p id="count">count: {props.data.count}</p>
      <form method="post">
        <button id="inc" type="submit">
          increment
        </button>
      </form>
    </div>
  )
}
