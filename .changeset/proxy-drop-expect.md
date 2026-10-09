---
"@nifrajs/proxy": patch
---

A request sent with `Expect: 100-continue` now reaches the upstream. The proxy no longer forwards the `Expect` header: the front server has already answered the client's 100-continue, and the Node transport refuses a request that carries it, so the request was answered 502.
