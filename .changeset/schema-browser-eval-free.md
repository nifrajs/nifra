---
"@nifrajs/schema": patch
---

A schema validating in a browser page uses TypeBox's eval-free checker from the start. It used to try a `new Function` compile first, which under a Content-Security-Policy without `'unsafe-eval'`, or under Trusted Types, is a violation the browser logs and sends to any report endpoint, once per schema, before the fallback took over. Servers and edge runtimes are unchanged.
