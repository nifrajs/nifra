---
"@nifrajs/web": minor
---

Add `@nifrajs/web/fn` - server functions, mounted as ordinary routes.

```ts
// app/actions/todos.fn.ts
export const addTodo = serverFn(
  { input: t.object({ text: t.string({ minLength: 1 }) }), capabilities: ["db.write"] },
  async ({ text }, c) => db.todos.insert({ text }),
)

// server
import * as todos from "./actions/todos.fn"
app.use(serverFunctions("todos", todos))   // -> POST /_nifra/fn/todos/addTodo
```

A mounted function registers through the ordinary public `register()`, so it is a route like any other
and inherits the body cap, schema validation, capability declarations, the effect ledger, and
`nifra assure`. Nothing in `@nifrajs/core` changed and no request-path branch was added, so an app that
mounts none of them pays nothing.

Every server function is a public POST endpoint whose arguments the caller controls entirely, so the
guards are structural rather than documented:

- **`application/json` only.** A cross-origin form can send only urlencoded, multipart or text/plain,
  so requiring JSON forces a preflight the browser blocks. Both alternatives were measured first: a
  body schema alone still accepts a cross-origin urlencoded form, and `c.boundedJson` alone accepts a
  `text/plain` body crafted to parse as JSON. A function with no input schema has no body reader at
  all, which is where this guard is the only defence.
- **Same-origin only** when an `Origin` is present - defence in depth behind the JSON requirement.
- **Input is always validated**; no schema means no argument, never an unchecked one.
- **No closures.** A function is a module-level export taking explicit arguments, which removes the
  serialised-closure class rather than defending it.

This is the registration half. The client build transform that turns a `*.fn.ts` import into a typed
RPC stub lands separately; until then, call a mounted function from the server or over the typed client.
