---
"@nifrajs/core": patch
---

In development, when a hook reads the request body as a stream through `c.req.body`, the body readers after it - a body schema, `c.boundedJson()`, the handler's `c.req.json()` - fail with an error that says the body was read as a stream and to read it with `c.req.bytes()` in the hook, which later readers replay. Before, they failed on a locked stream or reported the body as invalid JSON. A production `NODE_ENV` build carries none of this check.
