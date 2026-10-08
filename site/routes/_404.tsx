import { pageMeta } from "../shared/meta"

export const meta = pageMeta("Nifra - Not found", "That page doesn't exist.")

export default function NotFound() {
  return (
    <section className="notfound">
      <h1>404</h1>
      <p>No route matches this address. It may have moved, or the link may be wrong.</p>
      <a className="button ghost" href="/">
        Back to the home page
      </a>
    </section>
  )
}
