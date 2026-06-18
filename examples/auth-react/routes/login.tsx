export const meta = { title: "nifra — auth demo (login)" }

// Public login page. The form POSTs to the /api/login nifra route (server.ts), which has the full
// Context needed to write the session cookie — a file-route `action` can't set cookies, so session
// writes live in a plain route. Progressive enhancement: the native form POST works with JS off.
export default function Login() {
  return (
    <section>
      <p>
        Enter any username to sign in (this demo has no password — nifra owns the session, not
        identity).
      </p>
      <form method="post" action="/api/login">
        <input id="username" name="username" placeholder="username" autoComplete="username" />
        <button id="login" type="submit">
          sign in
        </button>
      </form>
    </section>
  )
}
