---
"@nifrajs/middleware": patch
"@nifrajs/env": patch
"@nifrajs/web": patch
"@nifrajs/auth": patch
---

`etag()` keeps an `ETag` the handler already set and answers `If-None-Match` against it, instead of replacing an app-managed version with a content hash. `etag()`, `conditionalResponse()` and `rangeResponse()` read an `If-None-Match` list with a comma inside a quoted ETag as one tag.

`env.number()` reads plain decimal text only (`0x10`, `1e3` and `Infinity` are refused), and `env.number()` and `env.port()` treat a value of only spaces as unset, so a `default` applies. `env.boolean({ default })` returns the default for a variable that is set but empty.

`serverFunctions()` mounts a second module under a namespace already in use, so `admin/todos.fn.ts` and `user/todos.fn.ts` are both served; an export name both modules use fails at boot as a duplicate route. Before, the second module was skipped and its functions answered 404. A module no app uses any more is not kept in memory by its namespace. The client build fails on a `*.fn.ts` file whose name `serverFunctions()` would refuse as a namespace, naming the file.

`requireSession()` documents that it passes any non-empty session, which a visitor can have before signing in; `requireUser()` is the signed-in guard.
