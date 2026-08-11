---
"@nifrajs/core": minor
"@nifrajs/i18n": patch
---

`__Secure-` and `__Host-` cookie name prefixes (RFC 6265bis) are now enforced, matched
case-insensitively the way browsers match them. `serializeCookie` throws on a `Set-Cookie` that
violates its name's prefix contract - `__Secure-` requires `Secure`; `__Host-` requires `Secure`
and `Path=/` and forbids `Domain` - instead of emitting a cookie the user agent silently discards.
`c.set.cookie`'s secure defaults already satisfy both contracts, so prefixed names work with zero
configuration, and `c.set.deleteCookie` applies `Secure` to the deletion write for a prefixed name
so the browser accepts the deletion (the failure mode behind Hono's CVE-2026-39410 class: a
non-conforming deletion leaves the cookie alive after logout). The new `cookieNamePrefix(name)`
export classifies a name as `"secure"`, `"host"`, or unprefixed. `@nifrajs/i18n`'s `localeDetector`
applies `Secure` automatically when its persist cookie name carries a prefix.
