/** @jsxImportSource preact */

import { href } from "@nifrajs/web-preact/router"
import type { ComponentChildren } from "preact"

/** Root layout - wraps every page; the nav proves the layout renders on each route. */
export default function Layout(props: { children?: ComponentChildren }) {
  return (
    <div>
      <nav id="nav">
        <a href={href({ to: "/" })}>home</a> · <a href={href({ to: "/about" })}>about</a>
      </nav>
      {props.children}
    </div>
  )
}
