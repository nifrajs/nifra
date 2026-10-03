---
"@nifrajs/core": patch
---

`responseContract()` holds a `c.json(...)` reply to the route's declared schema, as it does a returned value: `"enforce"` re-serializes the validated value with the reply's status and headers, and `"warn"` reports undeclared fields. In `"warn"` mode a `status(...)` result is now served with its own status and headers.
