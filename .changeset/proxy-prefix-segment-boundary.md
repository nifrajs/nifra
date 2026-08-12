---
"@nifrajs/proxy": patch
---

`stripPrefix` now only strips on a path-segment boundary. `stripPrefix: "/api"` matched `/apikeys` as
well as `/api/...` and forwarded it upstream as `/keys`, which is a different route than the caller
asked for - and, where the prefix marks a trust boundary, a route on the other side of it. A path must
now equal the prefix or continue with `/`.
