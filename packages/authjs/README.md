# `@nifrajs/authjs`

Official [Auth.js](https://authjs.dev) integration for nifra - backend mount, session helpers,
route guards, a framework-agnostic client, and React bindings.

```ts
import { authjs, getSession, requireAuthUser } from "@nifrajs/authjs"
import GitHub from "@auth/core/providers/github"

const authConfig = {
  providers: [GitHub({ clientId: process.env.GITHUB_ID! })],
  secret: process.env.AUTH_SECRET!,
  trustHost: true,
}

export const app = server()
  .use(authjs(authConfig)) // serves /api/auth/* (sign-in, callbacks, session, sign-out)
  .get("/me", async (c) => ({ user: (await getSession(c.req, authConfig))?.user ?? null }))
```

- `authjs(config, options?)` - identity plugin mounting Auth.js at `/api/auth/*` (GET + POST).
  Secrets resolve per request (explicit → platform binding → `process.env`); missing fails loud.
- `getSession(req, config)` - `Session | null`, usable in handlers and loaders.
- `requireAuthUser(req, config, { redirectTo? })` - returns the user or throws a 401/redirect.
- `@nifrajs/authjs/client` - `createAuthClient()` (session, sign-in, sign-out) for any frontend.
- `@nifrajs/web-react/auth` - `<AuthSessionProvider>` + `useAuthSession()`.

Auth.js itself does the security-critical work (PKCE, state, token verification); this package
is the nifra-shaped surface over `@auth/core`. See `/docs/auth` (Auth.js section) for the full
guide, including proxies (`authUrl`) and edge secret bindings.

## For AI agents

Start with [`LLM.md`](./LLM.md) - this package's contract card. For the wider framework, see the
repository [`llms-full.txt`](../../llms-full.txt) corpus.
