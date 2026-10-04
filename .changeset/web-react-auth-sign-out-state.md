---
"@nifrajs/web-react": patch
---

`useAuthSession().signOut()` leaves the `<AuthSessionProvider>` subtree unauthenticated once the server has ended the session, including with `redirect: false`, where the page stays and used to go on showing the signed-out user's session. A sign-out the server refuses keeps the session.
