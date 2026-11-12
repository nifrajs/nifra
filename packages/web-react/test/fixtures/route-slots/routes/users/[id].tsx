import { useState } from "react"

interface UserData {
  readonly id: string
  readonly viewer: string
  readonly loads: number
}

export default function User({ data }: { readonly data: UserData }) {
  const [count, setCount] = useState(0)

  return (
    <article id="inspector-user" data-viewer={data.viewer} data-loads={data.loads}>
      <p>
        User {data.id} for {data.viewer}
      </p>
      <button id="inspector-count" type="button" onClick={() => setCount((value) => value + 1)}>
        inspector count {count}
      </button>
    </article>
  )
}
