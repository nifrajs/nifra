import { useState } from "react"

interface ActivityData {
  readonly viewer: string
  readonly loads: number
}

export default function Activity({ data }: { readonly data: ActivityData }) {
  const [count, setCount] = useState(0)

  return (
    <article id="activity" data-viewer={data.viewer} data-loads={data.loads}>
      <p>Activity for {data.viewer}</p>
      <button id="activity-count" type="button" onClick={() => setCount((value) => value + 1)}>
        activity count {count}
      </button>
    </article>
  )
}
