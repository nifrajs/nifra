---
"@nifrajs/cli": minor
---

`nifra check` can now reach green on an app that intentionally mounts a non-typed sub-app, and raw-Response routes have an explicit opt-out.

- **`nifra.check.json` external-mount allowlist.** A relative `fetch()` to a mounted handler that lives outside the typed contract (e.g. an auth plugin that owns `/auth/**`) was flagged as a hand-rolled own-API call - an error you could never clear. Declare those prefixes in `nifra.check.json` (`{ "externalMounts": ["/auth"] }`, segment-anchored: `/auth` blesses `/auth` and `/auth/**` but not `/authors`) and the typed-client scan skips them. The blessed prefixes are echoed on the result and printed in the report, so a suppressed mount stays auditable instead of silently hiding real drift. A malformed `nifra.check.json` is a non-fatal warning; the allowlist is simply ignored.
- **`// nifra-expect raw-response` pragma.** A route that deliberately returns a raw `Response` (a file or redirect) raised the `response-route` advisory with no way to mark it intentional. A pragma comment on the return line, or the line above, now silences it for that route.
- **Streaming guidance.** The `response-route` advisory now points streaming routes at the typed SSE route (`app.sse(...)`), which keeps typed events instead of collapsing the client to `data: never`.
