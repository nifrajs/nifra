---
"@nifrajs/web": patch
"@nifrajs/cli": patch
---

A Better Auth session cookie counts as a sign-in cookie for kept pages under any
`advanced.cookiePrefix`, so a sign-in or sign-out through `<prefix>.session_token` rotates the identity
epoch, and its `session_data` and `dont_remember` cookies are never reported. An app's own
`keepAlive.ignoreCookies` entry outranks the suffix. `nifra doctor` notes keep-alive routes in an app
whose source renames a session cookie outright (Better Auth's `advanced.cookies.session_token.name`,
Auth.js's `cookies.sessionToken.name`, `cookieName`) without naming it in `identityCookies`.
