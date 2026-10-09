---
"@nifrajs/middleware": patch
---

`csrf()` publishes its route evidence for every method it guards. It guards every method but GET, HEAD and OPTIONS, custom ones included, but published evidence only for POST, PUT, PATCH and DELETE, and dropped custom methods from an explicit `methods` list. An assurance policy can now see that a custom-method route is protected.
