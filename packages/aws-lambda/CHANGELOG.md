# @nifrajs/aws-lambda

## 5.3.0

No changes in this release.

## 5.2.1

No changes in this release.

## 5.2.0

### Patch Changes

- 9498cf8: The package ships its `CHANGELOG.md`, so the installed package has the notes for every version, as the GitHub release does. Before, the tarball held only the code, `README.md`, `LICENSE` and `package.json`.

## 5.1.0

### Patch Changes

- 74b8c29: A `HEAD` request now gets a body-less answer from both `handle()` and `streamHandle()`: the GET route's status and headers, an empty `body`, and no streamed chunks. Before, the adapter returned the full GET body for `HEAD`, and a streaming route was read to its end. A streaming body is now cancelled instead, so its producer learns nobody is reading, as on the Node, Bun and Deno adapters.

## 5.0.0

### Patch Changes

- 9f5daa8: When an event carries no `requestContext.domainName`, the adapter uses the `Host` header for the request URL only if it is a plain host and port. A `Host` holding `/`, `?`, `#` or `@` can no longer change the URL's host or the path the app routes on; such a request is built on `localhost` instead.

## 4.0.2

## 4.0.1

## 4.0.0

### Patch Changes

- 031c33d: fix(runtime): preserve typed-array compatibility across Fetch runtimes and reject invalid request bodies at the runner boundary.

## 3.5.0

## 3.4.0

## 3.3.0

## 3.2.0

## 3.1.0

## 3.0.0

## 2.14.1

## 2.14.0

## 2.13.0

## 2.12.1

## 2.12.0

### Minor Changes

- 2a01366: New package: AWS Lambda adapter for API Gateway HTTP APIs (payload v2) and Lambda Function URLs.

  - `handle(app)` returns a buffered v2 handler; `streamHandle(app)` streams responses on Function
    URLs with `InvokeMode: RESPONSE_STREAM` via `awslambda.streamifyResponse`.
  - The request body is decoded and its real size checked against `maxBodyBytes` (default 1,000,000)
    before a `Request` is constructed - the event's own length claims are never trusted; over the
    limit answers a flat `413`.
  - Request headers are assembled in exactly one place from the v2 `headers` map plus the canonical
    `cookies` array; response `Set-Cookie` values travel in the result's `cookies` array, one entry
    each, never comma-joined.
  - Response `isBase64Encoded` is decided by a strict UTF-8 decode of the actual bytes, never by
    content-type guessing.
  - `event.requestContext.http.sourceIp` feeds core's client-IP seam (`c.clientIp`); the event and
    context ride on `c.env` (`server<LambdaEnv>()`); `waitUntil` work settles before the container
    freezes; uncaught errors collapse to the flat `internal_error` 500 with no event echo.

  REST APIs (payload v1) and ALB events are out of scope.

### Patch Changes

- 6392995: `handle` and `streamHandle` validate `maxBodyBytes` at wire-up: a `NaN`, fractional, or negative value
  throws a `RangeError` instead of being installed as a cap. `NaN` compares false against every size, so
  the misconfiguration read as "configured" while enforcing nothing.
