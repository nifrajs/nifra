export const meta = { title: "Not found" }

export default function NotFound() {
  return (
    <section class="hero">
      <h1>
        <span class="grad">404</span>
      </h1>
      <p>That page doesn't exist.</p>
      <a class="btn" href="/">
        ← Back home
      </a>
    </section>
  )
}
