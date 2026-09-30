---
"@nifrajs/core": minor
"@nifrajs/schema": minor
"@nifrajs/cli": minor
---

feat(core): one handler can be registered under several methods, and under a method outside the
standard seven, with `all()` and `method()` from `@nifrajs/core/methods`:

```ts
import { server } from "@nifrajs/core/server"
import { all, method } from "@nifrajs/core/methods"

const app = server()
  // GET, POST, PUT, PATCH, DELETE, HEAD and OPTIONS /echo
  .use(all("/echo", (c) => ({ method: c.req.method })))
  .use(method("PURGE", "/cache/:key", (c) => ({ purged: c.params.key })))
  .use(method(["GET", "POST"], "/search", (c) => ({ q: c.query.get("q") })))
```

- Each method is an ordinary route: it is listed by `app.routes()`, takes a schema and hooks, works
  inside `group()`, and throws `DUPLICATE_ROUTE` against a route already registered for the same
  method and path. One call is one registration: if any of its routes is refused, none is added.
- `all()` is the seven standard methods, not a catch-all. A request with any other method is still a
  `405` with an `Allow` header. `mount()` remains the way to pass every method through.
- A method name is case-insensitive and registered uppercase. It is a token of letters, digits and
  hyphens that starts with a letter, at most 32 characters. `TRACE`, `CONNECT` and `TRACK` cannot be
  registered; those and any other value throw `INVALID_METHOD`.
- The standard methods in a call join the typed registry and the typed client. A custom method has
  no typed-client call.
- An assurance policy's `methods` selector takes standard methods only, so it never matches a
  custom-method route. Classify such a route with a path rule; unmatched, it is reported as
  `unclassified-route`.
- Whether a custom method reaches the app is up to the runtime's HTTP parser: `PROPFIND`, `REPORT`,
  `PURGE` and `QUERY` arrive on Bun, Node, Deno and workerd, and a token the parser does not know
  can be answered by the runtime itself.
- `Router.add` from `@nifrajs/core/router` accepts the same method tokens, and
  `isRegistrableMethod(name)` from that subpath reports whether a name is one.
  `RouteDescriptor.method` is typed `RouteMethod`: a standard `Method` or another such token.

feat(schema): `toOpenAPI` leaves a custom-method route out of the document. A path item has a field
for each standard method and none for any other.

feat(cli): `nifra check` reads the routes `all()` and `method()` register, so the duplicate,
overlap, reserved-segment and param-modifier rules cover them, reported once per call. The route
brief and `--json` output list a custom-method route with a `fetch` call. The capability report
attributes a module to every path an optional-param route serves, and to `all()` and `method()`
routes.
