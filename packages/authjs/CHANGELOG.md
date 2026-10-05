# @nifrajs/authjs

## 4.0.0

### Minor Changes

- 65f2d4b: `createAuthClient().signIn()` works with Auth.js v5, which refuses a `GET` to `/signin/:provider`. It now fetches a CSRF token, submits the sign-in as a `POST`, and navigates to the provider page Auth.js answers with (any `http(s)` address; anything else lands on `/`). `signIn()` therefore returns a `Promise<void>`, and so does `useAuthSession().signIn`. `signInUrl()` is deprecated: it names a URL Auth.js v5 only accepts as a CSRF-carrying `POST`.
- d8c2a35: Auth.js now reads its documented variables (`AUTH_URL`, `AUTH_TRUST_HOST`, `NODE_ENV`, `AUTH_<PROVIDER>_ID`, ...) from the platform bindings and the process environment. In production it trusts the request's `Host` header only when `trustHost` or `AUTH_TRUST_HOST` says so. A configured origin (`authUrl`, or `AUTH_URL`) is trusted, and every request is rewritten onto it. `getSession` and `requireAuthUser` take the mount's `basePath`, `authUrl` and `trustProxy`, and read the session on that origin and path.
- af7648c: feat(authjs): official Auth.js integration (backend + client + React bindings)

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

### Patch Changes

- Updated dependencies [dde125b]
- Updated dependencies [72b62fa]
- Updated dependencies [aa44e93]
- Updated dependencies [4a3ee60]
- Updated dependencies [aad6297]
- Updated dependencies [dad0d41]
- Updated dependencies [538adc2]
- Updated dependencies [f47edd1]
- Updated dependencies [df9530a]
- Updated dependencies [3e6973f]
- Updated dependencies [25e8edf]
- Updated dependencies [2b5e5fc]
- Updated dependencies [3b090de]
- Updated dependencies [da7d792]
- Updated dependencies [612a296]
- Updated dependencies [fb14dfa]
- Updated dependencies [8ae97f6]
- Updated dependencies [4af6f39]
- Updated dependencies [ca8b50d]
- Updated dependencies [b00a889]
- Updated dependencies [b53d64f]
- Updated dependencies [66fd712]
- Updated dependencies [9c3d524]
- Updated dependencies [738e7a1]
- Updated dependencies [4801cac]
- Updated dependencies [1b2d53a]
- Updated dependencies [25fe13d]
- Updated dependencies [0852290]
- Updated dependencies [0589dbe]
- Updated dependencies [2e2d8c0]
- Updated dependencies [856f5ce]
- Updated dependencies [18aa5aa]
- Updated dependencies [cfd86b3]
- Updated dependencies [8ff96c9]
- Updated dependencies [4c46199]
- Updated dependencies [eef4932]
- Updated dependencies [6de8686]
- Updated dependencies [d7892ea]
- Updated dependencies [4936309]
- Updated dependencies [ff5a779]
- Updated dependencies [bbdc5a1]
- Updated dependencies [10bc446]
- Updated dependencies [e8270d9]
- Updated dependencies [ff4a062]
- Updated dependencies [43ba944]
- Updated dependencies [46c741a]
- Updated dependencies [7bfa25e]
- Updated dependencies [4936309]
- Updated dependencies [6e257a6]
- Updated dependencies [4a03d30]
- Updated dependencies [8e30090]
- Updated dependencies [28f3aaf]
- Updated dependencies [6d20355]
- Updated dependencies [6907cbe]
- Updated dependencies [b64c3ee]
- Updated dependencies [bda9637]
- Updated dependencies [81c720e]
- Updated dependencies [ed60b23]
- Updated dependencies [a158b74]
- Updated dependencies [ff25d68]
  - @nifrajs/core@4.0.0
