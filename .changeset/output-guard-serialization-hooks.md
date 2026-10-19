---
"@nifrajs/web": patch
---

The output guard no longer lets a serialization hook decide what reaches the browser. A plain object or array with its own `toJSON` (enumerable or not), or an array subclass with one on its prototype, is sent as the declared fields and items it holds. A loader returning a declared object with a hidden `toJSON` could previously send whatever that method returned, undeclared fields included, in both the page and the data request.
