import { href } from "@nifrajs/web-react/router"

export const meta = { title: "Not found" }

export default function NotFound() {
  return (
    <section className="hero">
      <h1>
        <span className="grad">404</span>
      </h1>
      <p>That page doesn't exist.</p>
      <a className="btn" href={href({ to: "/" })}>
        ← Back home
      </a>
    </section>
  )
}
