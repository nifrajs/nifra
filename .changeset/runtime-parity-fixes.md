---
"@nifrajs/client": minor
"@nifrajs/core": minor
"@nifrajs/mock": minor
"@nifrajs/web": minor
---

Make route batches atomic, seal server configuration after `listen()`, encode array query values as
repeated keys, and align web route matching with the server.

Three behavior changes to know about:

- **Configuring a server after `listen()` now throws** instead of reaching some traffic and not the
  rest. Bun's native route table is compiled when you listen, so a hook added afterwards applied to
  `app.fetch()` but not to real HTTP requests: an `onRequest` guard installed late was silently
  skipped on the wire. Register routes, hooks, plugins, and context before listening.
- **Array query values serialize as repeated keys** (`?tag=a&tag=b`), not `?tag=a%2Cb`, so a route
  whose `query` schema declares an array now receives one.
- **The web matcher applies the server's trailing-slash rule.** `/users/7/` no longer matches
  `/users/:id` in the browser, matching the 404 the server already returns, and a malformed percent
  encoding reports no route instead of throwing.

A route batch from `implement()` or `merge()` commits only once every route in it validates, so a
collision partway through leaves matching and reflection untouched instead of stranding the routes
registered before it.

Each route now owns one immutable compiled execution plan shared by portable, Node-direct, and
Bun-native dispatch. This also fixes validation recovery being skipped when a derive moved a route
from a specialized lane to the generic lifecycle.

Core, browser navigation, Bun-native parameter metadata, and mock routing now consume the same
compiled pattern kernel. Static routes beat parameters and parameters beat wildcards regardless of
manifest order, with one grammar, trailing-slash policy, and malformed-encoding rule.
