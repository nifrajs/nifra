import type { ReactNode } from "react"
export default function Layout(props: { children?: ReactNode }) {
  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        maxWidth: 840,
        margin: "2rem auto",
        padding: "0 1rem",
      }}
    >
      <h1>nifra — image demo</h1>
      <p style={{ color: "#555" }}>
        A CLS-safe responsive <code>&lt;Image&gt;</code>. Each picture is a labeled SVG sized by the
        loader's <code>?w=</code> — so the number you see is the <code>srcSet</code> candidate your
        browser actually picked (try a HiDPI display, or resize the window).
      </p>
      {props.children}
    </main>
  )
}
