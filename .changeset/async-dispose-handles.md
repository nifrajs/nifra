---
"@nifrajs/core": minor
"@nifrajs/node": minor
"@nifrajs/deno": minor
"@nifrajs/jobs": minor
"@nifrajs/cron": minor
"@nifrajs/client": minor
---

Server, worker, scheduler, subscription, and socket handles stop when their scope ends. Hold a Bun `listen()` handle, a Node or Deno `serve()` handle, or a jobs worker with `await using`; hold a cron scheduler, a client subscription, or a client WebSocket with `using`.
