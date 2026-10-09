---
"@nifrajs/client": patch
---

A body the client cannot decode is a Result, not a throw. A proxy's HTML error page labelled `application/json`, or a nifra media type with no codec registered, used to reject the call with a `TransportCodecError`; it now resolves to `{ ok: false, status: 0, data: null, error: { error: "malformed_response" } }`. A media type that only shares the JSON prefix is read like any other body: `application/json-patch+json` is parsed as JSON and `application/jsonl` comes back as its text, where both used to throw.
