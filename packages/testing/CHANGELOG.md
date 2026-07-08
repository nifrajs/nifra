# @nifrajs/testing

## 1.3.0

### Patch Changes

- Updated dependencies [4a4b1c4]
  - @nifrajs/client@1.3.0

## 1.2.2

### Patch Changes

- @nifrajs/client@1.2.2

## 1.2.1

### Patch Changes

- @nifrajs/client@1.2.1

## 1.2.0

### Patch Changes

- @nifrajs/client@1.2.0

## 1.1.0

### Minor Changes

- acb9e97: feat(testing): add `@nifrajs/testing` — cookie-aware in-process test sessions

  `@nifrajs/client`'s `testClient` already drives an app's `fetch` with end-to-end types (no server, port,
  or network). This adds what it doesn't: a `cookieJar()` and a cookie-persisting `testSession(app)`, so a
  login → authenticated-request flow tests as easily as a single request — `Set-Cookie` is captured and the
  `Cookie` header is sent automatically across calls (honouring `Max-Age=0` / past `Expires` for logout).
  Same typed in-process client; the only addition is a shared cookie jar.

### Patch Changes

- @nifrajs/client@1.1.0
