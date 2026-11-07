---
"@nifrajs/core": minor
"@nifrajs/node": minor
"@nifrajs/deno": minor
"@nifrajs/jobs": minor
"@nifrajs/cron": minor
"@nifrajs/client": minor
---

Server, worker, scheduler, subscription, and socket handles work with `using` and `await using`: a Bun `listen()` handle, a Node or Deno `serve()` handle, a jobs worker, a cron scheduler, a client subscription, and a client WebSocket each stop when their scope ends.
