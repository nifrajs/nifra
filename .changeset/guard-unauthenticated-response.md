---
"@nifrajs/auth": minor
"@nifrajs/better-auth": minor
"@nifrajs/authjs": minor
---

The session guards take `unauthenticated: { status, body, headers }` to set the response they deny a missing session with, in place of the default `401` JSON: `requireSession` and `requireUser` in `@nifrajs/auth`, `requireSession`, `requirePrincipal` and `authed` in `@nifrajs/better-auth`, and `requireAuthUser` in `@nifrajs/authjs`. The status must be 400-599, and a guard given both `redirectTo` and `unauthenticated` throws. `UnauthenticatedResponse` is exported from each package.
