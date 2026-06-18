import { useState } from "react"

export interface PageData {
  message: string
  start: number
}

/** A React route component — `data` is the (typed) loader output. The state proves hydration. */
export function App(props: { data: PageData }) {
  const [count, setCount] = useState(props.data.start)
  return (
    <main>
      <h1>{props.data.message}</h1>
      <button id="btn" type="button" onClick={() => setCount((c) => c + 1)}>
        count: {count}
      </button>
    </main>
  )
}
