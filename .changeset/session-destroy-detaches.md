---
"@nifrajs/auth": patch
"@nifrajs/cli": patch
---

`destroy(c, session)` empties and detaches the session object it is passed. Committing that object later in the same request now starts a new session holding only what was set after the call. In store mode, that commit used to vanish against the revocation marker, so a flash message set after logout was lost without an error. In cookie mode, it signed the logged-out data, user id included, into a fresh cookie. The 5.3.0 upgrade notes say so.
