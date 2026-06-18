# auth-react — sessions, guards & CSRF on nifra

A nifra + React app demonstrating `@nifrajs/auth`: a **protected page**, a **login form**, **logout**, a
route **guard**, and **CSRF** protection — all on signed-cookie sessions backed by a server store.

```sh
bun run examples/auth-react/build.ts
bun examples/auth-react/server.ts        # http://localhost:3000
```

- Visit `/` while signed out → the loader's `requireUser(…, { redirectTo: "/login" })` redirects you.
- Enter any username at `/login` → `POST /api/login` sets the session (rotating the id — fixation
  defense) and redirects home. (No password: nifra owns the *session*, not identity — a real app
  verifies credentials / OAuth via Better Auth, Lucia, etc. before `session.set("userId", …)`.)
- `/` now greets you; **log out** → `POST /api/logout` destroys the server-side session + clears the
  cookie.

## How it maps to nifra

- **Reading** the session in a loader: `await sessions.read(request)` (loaders can read the request but
  can't write cookies).
- **Writing** the session: in plain nifra routes (`app.post("/api/login", …)`) which have the full
  `Context` (`c.set.cookie`). The session cookie is `HttpOnly` + signed; in store mode the cookie is
  just an opaque id (data stays server-side).
- **Guard**: `requireUser(session, "userId", { redirectTo })` throws a redirect; nifra returns it.
- **CSRF**: `app.use(csrf())` — Origin check on unsafe methods.

Production swaps `MemorySessionStore` → `KVSessionStore(env.SESSIONS)` and the dev secret → a real one
(see `auth.ts`); nothing else changes.
