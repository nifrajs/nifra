/** @jsxImportSource preact */

import { href } from "@nifrajs/web-preact/router"
import type { ComponentChildren } from "preact"

/** Root layout - wraps every page; the nav proves the layout renders + client nav works on Preact. */
export default function Layout(props: { children?: ComponentChildren }) {
  return (
    <div>
      <nav id="nav">
        <a href={href({ to: "/" })}>home</a> · <a href={href({ to: "/todos" })}>todos</a> ·{" "}
        <a href={href({ to: "/search", search: { page: 2, q: "hi" } })}>search</a>
      </nav>
      {props.children}
    </div>
  )
}
