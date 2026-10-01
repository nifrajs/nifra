---
"@nifrajs/web": patch
---

perf(web): a page with no layouts, and a layout loader that returns a plain value, render without
extra promise turns. A layout loader may still return a promise, a thenable, or a promise from
another realm; each is awaited exactly as before, and a loader that throws synchronously fails the
page the same way a rejected one does.
