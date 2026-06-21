# @nifrajs/better-auth

Mount [better-auth](https://better-auth.com) into a [nifra](https://github.com/nifra) app: one
`app.use(betterAuth(auth))` wires every better-auth endpoint (sign-in/up/out, OAuth callbacks,
session, 2FA, magic links, …) under `/api/auth/*`, plus typed `getSession` / `requireSession` guards
for reading and protecting routes.

This package has **no runtime dependency on better-auth** — it consumes your `auth` object
structurally, so your better-auth types flow through by inference and your tests need no DB.

## Install

```sh
bun add @nifrajs/better-auth better-auth
```

## Setup

Configure better-auth as usual (database, providers, …), then mount it:

```ts
// auth.ts
import { betterAuth as createBetterAuth } from "better-auth"
export const auth = createBetterAuth({
  database: /* your adapter */,
  emailAndPassword: { enabled: true },
  // basePath defaults to "/api/auth"
})
```

```ts
// server.ts
import { server } from "@nifrajs/core"
import { betterAuth } from "@nifrajs/better-auth"
import { auth } from "./auth"

export const app = server()
  .use(betterAuth(auth)) // serves GET + POST /api/auth/*
  .get("/", () => ({ ok: true }))
```

`betterAuth(auth, { basePath })` overrides the mount path; otherwise it uses `auth.options.basePath`,
then `/api/auth`. The plugin is **idempotent** (named `"better-auth"`): applying it twice mounts once.

## Read the session

`getSession(auth, request)` is a typed wrapper over `auth.api.getSession`. Pass the raw `Request` so it
works in both core handlers (`c.req`) and `@nifrajs/web` loaders/actions (`request`):

```ts
import { getSession } from "@nifrajs/better-auth"

app.get("/me", async (c) => {
  const session = await getSession(auth, c.req) // { user, session } | null — fully typed
  return session ? { email: session.user.email } : { email: null }
})
```

## Protect a route

`requireSession(auth, request, options?)` returns the non-null session or **throws a `Response`** —
nifra returns a thrown `Response` as-is, short-circuiting the handler:

```ts
import { requireSession } from "@nifrajs/better-auth"

// 401 JSON { ok: false, error: "unauthorized" } when signed out:
app.get("/account", async (c) => {
  const { user } = await requireSession(auth, c.req)
  return { id: user.id }
})

// 302 to a login page instead (same-origin path required):
export const loader = async ({ request }) => {
  const { user } = await requireSession(auth, request, { redirectTo: "/login" })
  return { user }
}
```

## API

| Export | Description |
| --- | --- |
| `betterAuth(auth, options?)` | Plugin that mounts better-auth's handler at `${basePath}/*` for GET + POST. |
| `getSession(auth, request)` | `Promise<SessionOf<A> \| null>` — typed wrapper over `auth.api.getSession`. |
| `requireSession(auth, request, options?)` | Returns the session or throws a `Response` (302 `redirectTo` / 401). |
| `SessionOf<A>` | The non-null session payload type inferred from your `auth`. |
| `BetterAuthLike` | The structural contract a better-auth instance satisfies. |

## License

MIT

## For AI agents

Start with [`LLM.md`](./LLM.md) — this package's contract card (the exports you call + its footguns),
one cheap read instead of the whole corpus. For the wider framework: the repo's
[`AGENTS.md`](../../AGENTS.md) is the copy-paste quick reference, and
[`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run `nifra check` as the
done-gate, or `nifra mcp` to give the agent live project tools.
