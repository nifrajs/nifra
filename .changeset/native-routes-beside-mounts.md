---
"@nifrajs/core": patch
---

Keep Bun's native route table for HTTP routes provably outside composed mount prefixes. Mounting an API no longer sends unrelated parent routes through the portable dispatcher. Routes that may overlap a mount, root mounts, and mounts serving WebSocket upgrades retain their existing dispatch behavior.
