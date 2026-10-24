---
"@nifrajs/web": minor
"@nifrajs/web-react": minor
"@nifrajs/web-svelte": minor
"@nifrajs/cli": minor
---

A route can keep its page mounted across navigations: `export const keepAlive = true` (or `{ revalidate: false }`) in a React or Svelte route. Back and forward to a kept page show it at once with its state, scroll and focus as the visitor left them, then revalidate its data in the background unless `revalidate` is `false` (a route's `clientLoader` then runs again over the server data the page was built from). At most three pages are kept per tab, each for up to ten minutes hidden (`keepAlive: { maxAge }` changes that). Kept pages are dropped when the visitor signs in or out (an identity epoch cookie the server sets, shared across tabs, which expires with the session cookie and is renewed with a rolling one), and the page on screen as that happens is not kept; also on a hot update and when the document enters the browser's own back/forward cache. Pages are wrapped at the layouts they do not share with the routes they navigate to, so a shared layout keeps one instance. `usePageVisibility()` from `@nifrajs/web-react/router` and `onPageHide` / `onPageShow` from `@nifrajs/web-svelte/router` let a kept page pause its own work while hidden.

`createWebApp({ keepAlive: { identityCookies, ignoreCookies } })` names the cookies that carry who the visitor is, beyond the defaults for nifra, Better Auth and Auth.js sessions; `rotateIdentityEpoch(c)` drops kept pages from a handler that changes identity another way. In development, a changed HttpOnly cookie that is neither an identity cookie nor ignored is reported once, and so is a stylesheet rule that selects a kept page as a direct child of its layout (the wrapper sits between them). `nifra doctor` names the kept routes of an app that uses an auth package.

An app with no `keepAlive` route ships the same client code as before.
