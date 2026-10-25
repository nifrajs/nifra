---
"@nifrajs/auth": minor
---

`csrf()` takes `exempt`: route patterns whose requests skip the Origin check, for a route no browser
calls that verifies its sender another way, such as a signed payment webhook arriving with no
`Origin`. Patterns are written as routes are (`/inbound/:vendor`) and matched against the path the
server routes, so any other path stays checked.
