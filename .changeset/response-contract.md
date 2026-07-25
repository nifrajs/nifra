---
"@nifrajs/core": minor
---

Add `responseContract()`, an opt-in plugin that makes a route's declared `response` schema hold at runtime.

A `response` schema is a lower bound: it says "at least these fields", never "only these". A handler
that returns a database row satisfying it also ships every other column, and nothing points at it -
TypeScript's excess-property check does not reach a handler's return position, and the client's type
reports the contract rather than the bytes. The result can appear with no code change at all: add a
column, and the next deploy ships it to browsers.

```ts
import { responseContract } from "@nifrajs/core/response-contract"
app.use(responseContract("enforce"))
```

- not installed (default) - unchanged behaviour, and the lane is absent from the bundle entirely.
- `"warn"` - checks each response, logs the undeclared fields by name, serves the payload unchanged.
- `"enforce"` - serializes the validated value, so undeclared data cannot reach the wire.

Enforcement follows the schema's own semantics, since Standard Schema exposes `validate` and no way to
enumerate declared keys: a stripping schema (Zod, Valibot) yields a cleaned value, while a strict one
(`@nifrajs/schema`'s `t.object`) reports issues and the response becomes a 500 with the detail logged
rather than returned. Routes with a `response` schema leave the fused and native fast paths while this
is enabled, the same trade an idempotent route makes.

It is a plugin rather than a server option so that apps which do not use it do not carry it: as an
option the check was statically imported by the kernel and cost every app ~0.5 KB gzip, which the
bundle-size gate caught. Behind the `@nifrajs/core/response-contract` subpath the lane arrives only
when installed, and the kernel keeps just the install seam (~0.2 KB).
