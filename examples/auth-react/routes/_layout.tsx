import type { ReactNode } from "react"

export default function Layout(props: { children?: ReactNode }) {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 480, margin: "3rem auto" }}>
      <h1>nifra — auth demo</h1>
      {props.children}
    </main>
  )
}
