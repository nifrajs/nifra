import Layout from "./_layout"

export const meta = { title: "Not found" }

// nifra's catch-all renders _404 without the layout chain, so it wraps itself in the root Layout.
export default function NotFound() {
  return (
    <Layout>
      <section className="hero">
        <h1>
          <span className="grad">404</span>
        </h1>
        <p>That page doesn't exist.</p>
        <a className="btn" href="/">
          ← Back home
        </a>
      </section>
    </Layout>
  )
}
