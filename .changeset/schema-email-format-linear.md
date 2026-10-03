---
"@nifrajs/schema": patch
---

The built-in `email` format checks in linear time on any input, and rejects a domain with an empty label (`ada@example..com`, `ada@.example.com`).
