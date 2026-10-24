---
"@nifrajs/authjs": minor
"@nifrajs/web-react": minor
---

`<AuthSessionProvider>` and `useAuthSession()` move from `@nifrajs/web-react/auth` to
`@nifrajs/authjs/react`, so the React adapter no longer depends on Auth.js in any form and Auth.js
carries its own framework bindings. `react` is an optional peer of `@nifrajs/authjs`; only the
`/react` entry imports it. `nifra upgrade` rewrites the import.
