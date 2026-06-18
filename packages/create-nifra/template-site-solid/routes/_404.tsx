import Layout from "./_layout"

export const meta = { title: "Not found" }

// nifra's catch-all renders _404 without the layout chain, so it wraps itself in the root Layout.
export default function NotFound() {
  return (
    <Layout>
      <section class="hero">
        <h1>
          <span class="grad">404</span>
        </h1>
        <p>That page doesn't exist.</p>
        <a class="btn" href="/">
          ← Back home
        </a>
      </section>
    </Layout>
  )
}
