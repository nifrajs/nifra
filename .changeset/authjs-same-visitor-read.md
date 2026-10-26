---
"@nifrajs/authjs": patch
"@nifrajs/web": patch
---

An Auth.js session read under `@nifrajs/web` keep-alive keeps the identity epoch. Auth.js encrypts a new session token on every read, so each one used to rotate the epoch, drop every kept page and reload the page on screen. When the request carries an epoch, the `authjs()` mount decrypts the token it received and the one it sent, and when every claim but `iat`, `exp` and `jti` matches it names that cookie as re-issued to the same visitor, in a response header the epoch hook reads and removes. A sign-in, a switch to another user and a sign-out still rotate the epoch, and a request without an epoch costs nothing extra.
