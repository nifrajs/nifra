---
"@nifrajs/core": patch
---

HEAD requests now answer via the matching GET route with identical status and headers (RFC 9110), on both the Bun native-route lane and the portable dispatcher. Previously a HEAD to a GET-only route returned a 405 JSON error, so custom headers and the declared content-type were lost. An explicitly registered HEAD route still takes precedence, and 405 Allow lists now advertise the implicit HEAD support.
