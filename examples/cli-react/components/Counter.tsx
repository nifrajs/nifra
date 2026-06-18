import { useState } from "react"
import styles from "./Counter.module.css" // CSS Module → typed, locally-scoped class names

export function Counter(props: { message: string }) {
  const [count, setCount] = useState(0)
  return (
    <div className={styles.box}>
      <h1 id="page">nifra CLI — zero-config</h1>
      <p id="ssr">{props.message}</p>
      <p id="count" className={styles.live}>
        count: {count}
      </p>
      <button id="inc" type="button" onClick={() => setCount((n) => n + 1)}>
        increment
      </button>
    </div>
  )
}
