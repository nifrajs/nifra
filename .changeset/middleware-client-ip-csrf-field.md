---
"@nifrajs/middleware": minor
"create-nifra": patch
---

feat(middleware): client-IP default keys and a CSRF form field

`rateLimit()` without `key`, `header`, or `trustedProxies` keys each bucket on the caller IP the
server resolved: the socket peer, or the app's `server({ clientIp })` trust declaration behind a
proxy. It no longer throws at construction, so the scaffolded backend templates, which pass only
`store`, `max`, and `windowMs`, start. A request with no resolvable caller IP gets 500
`rate_limit_key_unavailable`. A custom `key` receives the platform as its second argument.

`ipRestriction()` without `clientIp`, `header`, or `trustedProxies` judges the same resolved caller
IP, and denies a request that has none. A custom `clientIp` receives the platform as its second
argument.

Both read an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`, how Bun and Node report an IPv4 peer on
their default listener) as the IPv4 address it carries, so IPv4 `allow`/`deny` rules match it; a rule
may also be written in that form (`::ffff:10.0.0.0/104`). `rateLimit()` counts an IPv6 caller by its
`/64`, however the key was derived.

`csrf({ field })` also accepts the token from a form field in an
`application/x-www-form-urlencoded` or `multipart/form-data` body, for plain HTML forms that cannot
set a header. Bodies over `fieldMaxBytes` (default 64 KiB) are not read for the field, file parts
never count as the token, and the body stays readable by the route. Keep the Origin check on when
using a field.
