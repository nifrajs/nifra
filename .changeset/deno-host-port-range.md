---
"@nifrajs/core": patch
"@nifrajs/cli": patch
---

On Deno, a `Host` whose port is past 65535 is refused with 400 `invalid_host`, as `@nifrajs/node`
refuses it. A request with such a Host for a path holding a dot segment was answered 500.

The release verification plan runs `check:runtime-differential`, which serves one app on Bun, Node,
Deno and workerd and sends each the same generated requests.
