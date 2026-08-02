---
"@nifrajs/node": patch
---

`serve` no longer passes an explicit `undefined` hostname to `http.Server.listen`. Node accepts that overload, but Bun's Node-compatible server can misinterpret it (especially with `port: 0`) as a failed bind; omitting the argument selects the same default host with an unambiguous overload.
