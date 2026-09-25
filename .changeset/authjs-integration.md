---
"@nifrajs/authjs": minor
"@nifrajs/web-react": minor
---

feat(authjs): official Auth.js integration (backend + client + React bindings)

New `@nifrajs/authjs` package driving `@auth/core` itself - never a reimplementation of
the security-critical work:

- `authjs(config, options?)` mounts `/api/auth/*` (GET + POST) as a type-identity plugin:
  sign-in, OAuth callbacks, session, sign-out, CSRF. Secrets resolve per request
  (explicit → platform binding → `process.env`) and fail loud when missing; `authUrl`
  covers proxy deployments.
- `getSession(req, config)` (`Session | null`, handlers + loaders) and
  `requireAuthUser(req, config)` (401/redirect guard) mirror the `@nifrajs/better-auth`
  shapes.
- `@nifrajs/authjs/client` - framework-agnostic `createAuthClient()` (session, sign-in,
  sign-out over the mounted endpoints).
- `@nifrajs/web-react/auth` - `<AuthSessionProvider>` + `useAuthSession()` (other adapters
  wrap the agnostic client the same way `web-react/i18n` wraps `@nifrajs/i18n`).
