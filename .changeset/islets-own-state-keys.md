---
"@nifrajs/islets": patch
---

An island state key or a binding name that matches an `Object.prototype` member, such as `constructor` or `__proto__`, now names its own signal or handler. Before, it resolved to the inherited value.
