/** @jsxImportSource preact */
import { useState } from "preact/hooks"

/**
 * Component-only module → a Preact Fast Refresh (prefresh) boundary. Editing this file's JSX
 * hot-swaps it with `count` state preserved (no reload), exactly like the React example — keep a
 * route's view in a child component; the route file (loader/meta) full-reloads on save.
 */
export function Counter(props: { message: string }) {
  const [count, setCount] = useState(0)
  return (
    <div>
      <h1 id="page">nifra + Vite — true HMR (Preact)</h1>
      <p id="ssr">{props.message}</p>
      <p id="count">count: {count}</p>
      <button id="inc" type="button" onClick={() => setCount((n) => n + 1)}>
        increment
      </button>
    </div>
  )
}
