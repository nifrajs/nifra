---
"@nifrajs/core": patch
---

Fix the unhandled-request-error log so it carries the error's own message.

The record is built by spreading the caller's fields and then setting the framework's own keys, so
`level`, `message`, and `time` always win. The error log passed the thrown error's text as `message`,
which meant it was overwritten by the log message itself and never reached the sink:

```json
{ "method": "GET", "path": "/boom", "name": "Error", "message": "unhandled request error", "stack": "Error: kaboom\n at ..." }
```

The real text survived only incidentally inside `stack`, and was lost outright for a non-`Error`
throw, which has no stack to hide in. It is now emitted as `detail`, matching the response-contract
logs:

```json
{ "method": "GET", "path": "/boom", "name": "Error", "detail": "kaboom", "stack": "Error: kaboom\n at ..." }
```

This is a shape change for anything parsing these lines. A consumer reading `message` on an error
record now gets the constant `"unhandled request error"` in every case rather than sometimes-there
diagnostic text - it was already that constant, so nothing loses information, but a dashboard or
alert grouping on that field should move to `detail`.
