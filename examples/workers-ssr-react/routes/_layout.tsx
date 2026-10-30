import { href } from "@nifrajs/web-react/router"
import type { ReactNode } from "react"

/** Root layout - wraps every page; the nav drives client-side navigation on the edge. */
export default function Layout(props: { children?: ReactNode }) {
  return (
    <div>
      <nav id="nav">
        <a href={href({ to: "/" })}>home</a> ·{" "}
        <a href={href({ to: "/users/:id", params: { id: "7" } })}>user 7</a> ·{" "}
        <a href={href({ to: "/about" })}>about</a> · <a href={href({ to: "/slow" })}>streaming</a>
      </nav>
      {props.children}
    </div>
  )
}
