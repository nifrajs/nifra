import type { ReactNode } from "react"

// Minimal layout — the renderPage chain wraps the page (Layout → App).
export default function Layout(props: { children: ReactNode }) {
  return <div id="app">{props.children}</div>
}
