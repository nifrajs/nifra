---
"@nifrajs/core": patch
---

`memoryChannelHub` takes `maxChannels` (default 4096) and forgets idle channels beyond it. A channel that comes back numbers its events above everything it sent before, so a resume token from before the eviction is refused.
