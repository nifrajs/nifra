import { createSignal } from "solid-js"

export interface PageData {
  message: string
  start: number
}

/** A route component — `data` is the (typed) loader output. The signal proves hydration. */
export function App(props: { data: PageData }) {
  const [count, setCount] = createSignal(props.data.start)
  return (
    <main>
      <h1>{props.data.message}</h1>
      <button id="btn" type="button" onClick={() => setCount(count() + 1)}>
        count: {count()}
      </button>
    </main>
  )
}
