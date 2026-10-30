import "./app.css" // global stylesheet → bundled + content-hashed by buildClient, linked into <head>
import { href } from "@nifrajs/web-react/router"
import type { ReactNode } from "react"

/** Root layout - wraps every page; the nav proves the layout renders on each route. */
export default function Layout(props: { children?: ReactNode }) {
  return (
    <div>
      <nav id="nav">
        <a href={href({ to: "/" })}>home</a> ·{" "}
        <a href={href({ to: "/users/:id", params: { id: "7" } })}>user 7</a> ·{" "}
        <a href={href({ to: "/slow" })}>streaming</a> · <a href={href({ to: "/todos" })}>todos</a> ·{" "}
        <a href={href({ to: "/search", search: { page: 2, q: "hi", view: "list" } })}>search</a>
      </nav>
      {props.children}
    </div>
  )
}
