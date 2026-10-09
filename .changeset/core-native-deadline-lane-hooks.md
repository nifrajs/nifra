---
"@nifrajs/core": patch
---

With `acceptInboundDeadlines` on, a route Bun's native table serves runs its header-only response hooks (`onResponseHeaders`) on a request that carries no deadline, and answers a render that throws through the app's error path. That lane used to skip the hooks, so the headers they set were missing from those responses.
