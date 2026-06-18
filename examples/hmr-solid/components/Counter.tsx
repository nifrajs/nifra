import { createSignal } from "solid-js"

/**
 * Component-only module → a Solid HMR boundary (solid-refresh). Editing this file's JSX hot-swaps it
 * with the `count` signal preserved (no reload) — keep a route's view here; the route file
 * (loader/meta) full-reloads on save.
 */
export function Counter(props: { message: string }) {
  const [count, setCount] = createSignal(0)
  return (
    <div>
      <h1 id="page">nifra + Vite — true HMR (Solid)</h1>
      <p id="ssr">{props.message}</p>
      <p id="count">count: {count()}</p>
      <button id="inc" type="button" onClick={() => setCount(count() + 1)}>
        increment
      </button>
    </div>
  )
}
