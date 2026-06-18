import { useState } from "react"

// Demonstrates the CLIENT-side error boundary: the component renders fine on SSR + initial hydrate,
// but throws on the 3rd render (a client state change). The root _error.tsx boundary (auto-wired into
// the client chain) catches it and renders the error UI in place — the app doesn't white-screen.
export const meta = { title: "nifra — crash" }

export default function Crash() {
  const [n, setN] = useState(0)
  if (n >= 3) throw new Error(`render crash at n=${n}`)
  return (
    <section>
      <h2>Client render-crash demo</h2>
      <p>
        Click 3× — the 3rd render throws, and the nearest _error boundary catches it (client-side).
      </p>
      <button id="crash-btn" type="button" onClick={() => setN(n + 1)}>
        clicked {n}× (throws at 3)
      </button>
    </section>
  )
}
