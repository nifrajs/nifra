---
"@nifrajs/client": patch
"@nifrajs/cli": patch
---

fix(client): a `.` or `..` param value is refused instead of sent

A URL reads a `.` or `..` path segment as a step to another path, in every encoding, so
`api.users({ id: ".." }).delete()` was a request for `DELETE /`, not for a user named `..`.

- A call whose path has a `.` or `..` segment sends nothing and resolves to
  `{ ok: false, status: 0, data: null, error: { error: "invalid_path" } }` - the shape a network
  failure takes. No `onRequest` hook runs and nothing is retried.
- `.subscribe()` reports `invalid_path` through `onError`, then closes. `.ws()` throws before a
  socket is opened.
- `inProcessClient` and `testClient` behave the same way.
- Values that only contain dots (`a.b`, `...`, `.hidden`) and a wildcard value such as `a/../b`
  (sent as one encoded segment) are unaffected.
- The Python and Go clients from `nifra sdk` refuse the same values: Python raises `ValueError`,
  Go returns an error.

Validate a param where it is read: a `.` or `..` sent by another client still reaches the route
as the param's value.
