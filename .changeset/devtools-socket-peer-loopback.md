---
"@nifrajs/devtools": patch
---

The loopback access gate reads the serving adapter's socket peer instead of the request URL's host.
An adapter that reports a peer address decides the gate from that address alone (`127.0.0.0/8`,
`::1`, and the IPv4-mapped `::ffff:127.x.x.x` form, with brackets and any zone suffix normalized
away), so the inbound `Host` header no longer influences whether a caller counts as local. Runtimes
with no socket peer, such as edge workers, keep the URL-host check.

`allowRemote`, the origin check, and the optional `authorize` hook are unchanged.
