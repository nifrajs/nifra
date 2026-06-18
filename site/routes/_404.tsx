import { pageMeta } from "../meta"
import Layout from "./_layout"

export const meta = pageMeta("Nifra — Not found", "That page doesn't exist.")

// Nifra's catch-all renders _404 WITHOUT the layout chain, so it wraps itself in the root Layout
// to get the chrome + styles (and the nav, so users can escape).
export default function NotFound() {
  return (
    <Layout>
      <section className="hero" style={{ paddingBottom: 56 }}>
        <h1>
          <span className="grad">404</span>
        </h1>
        <p className="tagline">That page wandered off — Nifra couldn't match a route for it.</p>
        <div className="cta">
          <a className="btn" href="/">
            ← Back home
          </a>
        </div>
      </section>
    </Layout>
  )
}
