---
"@nifrajs/core": minor
---

feat(core): `app.group(prefix, build)` declares routes under a static path prefix. The prefix is part
of every route's served path, so the typed client (`api.admin.users.get()`), `routes()`, OpenAPI,
capability events, the effect ledger, and idempotency keys all see `/admin/users`. `JoinRoutePath`
and `PrefixRegistry` are exported for the registry types.

- The builder inherits the parent's chain as it stands at the call (`derive`, `decorate`,
  `authenticate`, `beforeHandle`, `afterHandle`, `onError`, `around`, assurance, installed runtimes).
  Middleware the builder adds covers only the group's routes.
- The group's `onRequest`, `onResponse`, `responseHeaders`, and `onResponseFinalized` hooks run only
  for requests whose path is the prefix or under it. That includes that path's 404 and 405 responses.
- Groups nest, and a group's `"/"` route serves the prefix itself.
- A prefix must be static text. Params, wildcards, percent-escapes, empty or dot segments, and a
  trailing slash are refused at registration.
- The builder must synchronously return the group it was given. The group is closed once the builder
  returns or throws.
- A collision with an existing route throws `RouteConfigError`, and none of the group's routes are
  added.
- `.ws()`, mounts, MCP tools, and `merge()` are refused inside a group.

`merge()` now also carries the merged server's `onStop` hooks.
