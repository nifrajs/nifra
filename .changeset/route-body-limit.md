---
"@nifrajs/core": minor
---

Per-route transport body caps. A route or contract operation may declare `bodyLimit` - a byte count,
or the explicit string `"unlimited"` paired with a `bodyLimitReason` that records why the route is
exempt. The route's cap overrides the server-wide `maxBodyBytes` for that route only, so a single
upload endpoint no longer forces the whole app's ceiling upward, and an exemption is a reviewable
declaration rather than a silent absence. An invalid value - a cap that is not a non-negative safe
integer, `"unlimited"` without a non-empty reason, or a reason given without `"unlimited"` - is a
`RouteConfigError` carrying the `INVALID_BODY_LIMIT` code at registration, not a surprise at request
time.
