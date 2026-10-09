---
"@nifrajs/agent": patch
---

`runModelGateway` honours a `deadlineAt` more than about 24.8 days out instead of timing the attempt out at once, and a policy with any `maxAttempts` up to the 512 cap now runs every attempt. Retrying past roughly 128 to 255 attempts used to fail with `policy_denied` once the evidence log filled.
