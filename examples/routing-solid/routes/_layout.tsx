/** Root layout - wraps every page; the nav proves the layout renders on each route. */
import { href } from "@nifrajs/web-solid/router"

export default function Layout(props: { children?: unknown }) {
  return (
    <div>
      <nav id="nav">
        <a href={href({ to: "/" })}>home</a> ·{" "}
        <a href={href({ to: "/users/:id", params: { id: "7" } })}>user 7</a> ·{" "}
        <a href={href({ to: "/slow" })}>streaming</a>
      </nav>
      {props.children as never}
    </div>
  )
}
