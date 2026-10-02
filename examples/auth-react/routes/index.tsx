import type { Route } from "./+types/index"

export const meta = { title: "nifra - auth demo (home)" }

export default function Home(props: Route.ComponentProps) {
  return (
    <section>
      <p id="welcome">
        Signed in as <b>{props.data.userId}</b>.
      </p>
      <p>This page is protected - visiting it without a session redirects to /login.</p>
      <form method="post" action="/api/logout">
        <button id="logout" type="submit">
          log out
        </button>
      </form>
    </section>
  )
}
