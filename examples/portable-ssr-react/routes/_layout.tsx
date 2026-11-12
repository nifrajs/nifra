import { href } from "@nifrajs/web-react/router"
import type { ReactNode } from "react"

export default function Layout(props: { children?: ReactNode }) {
  return (
    <div>
      <nav id="nav">
        <a href={href({ to: "/" })}>home</a> ·{" "}
        <a href={href({ to: "/users/:id", params: { id: "7" } })}>user 7</a> ·{" "}
        <a href={href({ to: "/about" })}>about</a>
      </nav>
      {props.children}
    </div>
  )
}
