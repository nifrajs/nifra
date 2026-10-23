"use client"
import { useState } from "react"

/** A client island: clicks only the browser counts, from a start the server gives. */
export function Counter({ start }: { start: number }) {
  const [clicks, setClicks] = useState(start)
  return (
    <button id="island" type="button" onClick={() => setClicks(clicks + 1)}>
      {`clicked ${clicks}`}
    </button>
  )
}
