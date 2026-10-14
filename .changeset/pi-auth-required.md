---
"@nifrajs/pi": patch
"@nifrajs/cli": patch
---

A Pi turn whose provider refused its sign-in or API key now fails with `PI_AUTH_REQUIRED`, so a client can ask for a new login or key; any other failed model call stays `PI_MODEL_FAILED`. An expired OAuth login (`invalid_refresh_token`) or an incorrect API key used to report `PI_MODEL_FAILED` like an overloaded model. The 5.3.0 upgrade notes say so.
