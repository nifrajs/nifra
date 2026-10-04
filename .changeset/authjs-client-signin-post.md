---
"@nifrajs/authjs": minor
"@nifrajs/web-react": patch
---

`createAuthClient().signIn()` works with Auth.js v5, which refuses a `GET` to `/signin/:provider`. It now fetches a CSRF token, submits the sign-in as a `POST`, and navigates to the provider page Auth.js answers with (any `http(s)` address; anything else lands on `/`). `signIn()` therefore returns a `Promise<void>`, and so does `useAuthSession().signIn`. `signInUrl()` is deprecated: it names a URL Auth.js v5 only accepts as a CSRF-carrying `POST`.
