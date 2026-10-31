import { href } from "@nifrajs/web-react/router"

export default function NotFound() {
  return (
    <section>
      <h2>404 - not found</h2>
      <p>
        <a href={href({ to: "/" })}>← home</a>
      </p>
    </section>
  )
}
