import "./counter.css"
import { useState } from "react"

/**
 * Component-only module → a React Fast Refresh boundary. Editing this file's JSX HMR-swaps it with
 * `count` state preserved (no reload). This is the canonical pattern: keep a route's view in a child
 * component, leave `loader`/`action`/`meta` in the route file (which, having non-component exports,
 * is not a refresh boundary — editing it does a clean full reload instead).
 */
export function Counter(props: { message: string }) {
  const [count, setCount] = useState(0)
  return (
    <div className="counter">
      <h1 id="page">nifra + Vite — true HMR</h1>
      <p id="ssr">{props.message}</p>
      <p id="count">count: {count}</p>
      <button id="inc" type="button" onClick={() => setCount((n) => n + 1)}>
        increment
      </button>
    </div>
  )
}
