---
"@nifrajs/island-trigger": patch
---

`scheduleTrigger` ships smaller. Every strategy returns the same one-shot disposer, which stays safe to call after the trigger fired.
