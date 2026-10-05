---
"@nifrajs/web": patch
---

In Bun dev, deleting a route regenerates the client entry and runs the leak guard once instead of twice.
