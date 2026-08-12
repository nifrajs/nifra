---
"@nifrajs/core": minor
---

New `errorLogDetail` server option controls how much of an unhandled error reaches the log for a 500:
`"full"` (the default, unchanged - name, the error's own text as `detail`, and `stack`), `"message"`
(no stack), or `"none"` (name only). None of it ever reaches the client; a 500 response is a bare
`internal_error` either way. An error's text can quote the input that produced it, so an app whose log
sink is outside its trust boundary can now narrow what is recorded - the sharper instrument stays the
redacting logger (`jsonLogger({ valuePatterns: commonSecretPatterns })`), which scrubs tokens and
emails out of `detail` and `stack` while keeping the diagnosis intact.
