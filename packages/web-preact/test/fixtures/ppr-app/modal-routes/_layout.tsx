/** @jsxImportSource preact */
import type { ComponentChildren } from "preact"

export default function Layout(props: { readonly children?: ComponentChildren }) {
  return (
    <div>
      <nav>
        <a id="to-home" href="/">
          home
        </a>{" "}
        <a id="to-p1" href="/p/1">
          p1
        </a>{" "}
        <a id="to-p2" href="/p/2">
          p2
        </a>{" "}
        <a id="to-p2-slow" href="/p/2?slow=5000">
          p2 slow
        </a>{" "}
        <a id="to-other" href="/other">
          other
        </a>
      </nav>
      {/* WebKit paints a loading document only once it holds about 200 characters of text. */}
      <p>
        A small tea shop. Every order is packed by hand from loose leaf bought direct from the
        growers, weighed on the day it ships and sealed in a tin that keeps it fresh for a year. Ask
        about samples before you choose.
      </p>
      {props.children}
    </div>
  )
}
