---
"create-nifra": patch
---

`--auth better-auth` scaffolds ship no placeholder secret.

- `.env.example` leaves `BETTER_AUTH_SECRET` empty. Locally, better-auth falls back to its development secret; in production it refuses to start until a secret is set.
- The generated `backend/auth.ts` refuses a `BETTER_AUTH_SECRET` shorter than 32 characters in production, where better-auth itself only logs a warning.
