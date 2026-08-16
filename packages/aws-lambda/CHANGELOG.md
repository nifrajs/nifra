# @nifrajs/aws-lambda

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
