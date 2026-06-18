import type { ReactNode } from "react"

/** Root layout — rendered inside the document shell `renderPage` emits. */
export default function Layout(props: { children?: ReactNode }) {
  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        maxWidth: 640,
        margin: "3rem auto",
        padding: "0 1rem",
      }}
    >
      <h1>nifra + ISR</h1>
      {props.children}
    </main>
  )
}
