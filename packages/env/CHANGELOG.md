# @nifrajs/env

## 5.11.0

No changes in this release.

## 5.10.0

No changes in this release.

## 5.9.0

No changes in this release.

## 5.8.0

No changes in this release.

## 5.7.0

No changes in this release.

## 5.6.0

### Patch Changes

- 2eabd83: `etag()` keeps an `ETag` the handler already set and answers `If-None-Match` against it, instead of replacing an app-managed version with a content hash. `etag()`, `conditionalResponse()` and `rangeResponse()` read an `If-None-Match` list with a comma inside a quoted ETag as one tag.
  
  `env.number()` reads plain decimal text only (`0x10`, `1e3` and `Infinity` are refused), and `env.number()` and `env.port()` treat a value of only spaces as unset, so a `default` applies. `env.boolean({ default })` returns the default for a variable that is set but empty.
  
  `serverFunctions()` mounts a second module under a namespace already in use, so `admin/todos.fn.ts` and `user/todos.fn.ts` are both served; an export name both modules use fails at boot as a duplicate route. Before, the second module was skipped and its functions answered 404. A module no app uses any more is not kept in memory by its namespace. The client build fails on a `*.fn.ts` file whose name `serverFunctions()` would refuse as a namespace, naming the file.
  
  `requireSession()` documents that it passes any non-empty session, which a visitor can have before signing in; `requireUser()` is the signed-in guard.

## 5.5.1

No changes in this release.

## 5.5.0

No changes in this release.

## 5.4.0

No changes in this release.

## 5.3.0

No changes in this release.

## 5.2.1

No changes in this release.

## 5.2.0

### Patch Changes

- 9498cf8: The package ships its `CHANGELOG.md`, so the installed package has the notes for every version, as the GitHub release does. Before, the tarball held only the code, `README.md`, `LICENSE` and `package.json`.

## 5.1.0

### Patch Changes

- 56945a2: When a BYO validator (zod, valibot, `t` or your own) refuses a variable that is set, `defineEnv` now reports `KEY: is invalid (the validator's message is withheld, since it may quote the value)` instead of the validator's own message. Before, it showed that message with the exact value replaced by `<redacted>`, which missed a value the validator had escaped (a JSON-quoted string with `"` or `\`), cut short, or changed in case, so part or all of a secret reached the startup error. A refused unset variable still shows the validator's message, and the `env.*` helpers still give their value-free reasons.

## 5.0.0

### Patch Changes

- 0ce3c61: `defineEnv` and an event contract's `parse` and `create` still refuse an async validator with their synchronous error, and now also observe the validator's promise, so a validator that rejects no longer surfaces as an unhandled rejection after the caller catches the refusal.
- 3c6bf66: `defineEnv()` no longer prints a variable's value when a bring-your-own validator quotes it. A valibot message such as `Invalid email: Received "sk_live_..."`, or a hand-rolled one that echoes its input, went into the startup error as is. The value is now replaced with `<redacted>`. The `env.*` helpers already wrote value-free messages and are unchanged.

## 4.0.2

## 4.0.1

## 4.0.0

## 3.5.0

## 3.4.0

## 3.3.0

## 3.2.0

## 3.1.0

## 3.0.0

## 2.14.1

## 2.14.0

## 2.13.0

## 2.12.1

## 2.12.0

## 2.11.0

## 2.10.0

## 2.9.1

## 2.9.0

## 2.8.2

## 2.8.1

## 2.8.0

## 2.7.1

## 2.7.0

## 2.6.1

## 2.6.0

## 2.5.0

## 2.4.0

## 2.3.0

## 2.2.0

## 2.1.0

## 2.0.0

## 1.13.0

## 1.12.0

## 1.11.0

## 1.10.0

## 1.9.1

## 1.9.0

## 1.8.0

## 1.7.0

## 1.6.0

## 1.5.0

## 1.4.0

## 1.3.1

## 1.3.0

## 1.2.2

## 1.2.1

## 1.2.0

## 1.1.0

## 1.0.0

## 1.0.0-beta.4

## 1.0.0-beta.3

## 0.1.0-beta.2
