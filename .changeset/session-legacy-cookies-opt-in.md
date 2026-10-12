---
"@nifrajs/auth": patch
---

`createSessions` no longer accepts a session cookie signed in the pre-5.0 form (without the cookie name in the signature) unless you pass the new `acceptLegacyCookies: true`. Before, that fallback was always on, so any value the app signed with the session secret through `@nifrajs/core`'s `signValue` that parsed as a cookie-mode session (a signed preference cookie built from a form field, say) read as a session of the attacker's choosing, with an expiry of its own. A cookie-mode session's expiry is now also capped at `now + maxAge` on load, so no cookie can name a longer life. Migration: if you are upgrading from 4.x, or from 5.0 with sessions that have not been committed since, set `acceptLegacyCookies: true` to keep those users signed in, and remove it once one `maxAge` (7 days by default) has passed; each such session is re-signed in the current form on its next commit. Without it, those users are signed out once.
