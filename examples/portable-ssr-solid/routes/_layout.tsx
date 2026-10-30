/** Root layout - wraps every page; the nav drives client-side navigation on the edge. */
import { href } from "@nifrajs/web-solid/router"

export default function Layout(props: { children?: unknown }) {
  return (
    <div>
      <nav id="nav">
        <a href={href({ to: "/" })}>home</a> ·{" "}
        <a href={href({ to: "/users/:id", params: { id: "7" } })}>user 7</a> ·{" "}
        <a href={href({ to: "/about" })}>about</a>
      </nav>
      {props.children as never}
    </div>
  )
}
