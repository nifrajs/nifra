---
"@nifrajs/authjs": minor
---

Auth.js now reads its documented variables (`AUTH_URL`, `AUTH_TRUST_HOST`, `NODE_ENV`, `AUTH_<PROVIDER>_ID`, ...) from the platform bindings and the process environment. In production it trusts the request's `Host` header only when `trustHost` or `AUTH_TRUST_HOST` says so. A configured origin (`authUrl`, or `AUTH_URL`) is trusted, and every request is rewritten onto it. `getSession` and `requireAuthUser` take the mount's `basePath`, `authUrl` and `trustProxy`, and read the session on that origin and path.
