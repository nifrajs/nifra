---
"@nifrajs/core": minor
"@nifrajs/node-uws": minor
---

A request source that already holds a framed JSON body can hand it to the router synchronously, so a POST on such an engine no longer pays a promise per request. `readBodyFramed` keeps its behavior and now wraps the same parser; the node-uws declarative route table is regenerated to match.
