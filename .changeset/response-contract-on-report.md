---
"@nifrajs/core": minor
---

`responseContract(mode, { onReport })` calls a hook for every response the contract reports on, for a metric or an alert. The kinds are `violation` (enforce mode, a 500 went out instead), `warn` (warn mode, sent anyway) and `stripped` (enforce mode, sent without some fields). Each report carries the route's method and its registered pattern (`/users/:id`), the field names where they apply, and the message the log line carries. Values are never passed. A hook that throws, rejects or is not a function is logged once and changes no response. Logging is unchanged. An app that installs the plugin carries about 0.3 KB more gzipped; the kernel carries nothing.
