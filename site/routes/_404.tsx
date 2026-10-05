import { pageMeta } from "../shared/meta"
import Layout from "./_layout"

export const meta = pageMeta("Nifra - Not found", "That page doesn't exist.")

// Nifra's catch-all renders _404 WITHOUT the layout chain, so it wraps itself in the root Layout
// to get the chrome + styles (and the nav, so users can escape).
export default function NotFound() {
  return (
    <Layout>
      <section className="notfound">
        <h1>404</h1>
        <p>No route matches this address. It may have moved, or the link may be wrong.</p>
        <a className="button ghost" href="/">
          Back to the home page
        </a>
      </section>
    </Layout>
  )
}
