---
"@nifrajs/cli": patch
---

NF-C039 counts a contract's operations as served only where one mount prefix serves them together. Each operation was matched on its own by path suffix, so a `/` operation matched any route of its method and `/:id` matched any route ending in `/:id`: an implementation `backend/app.ts` never mounted could pass when unrelated routes happened to end the same way.
