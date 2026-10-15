---
"@nifrajs/client": patch
---

A closed `subscribe()` subscription removes its abort listener from the `signal` it was given. The listener stayed until that signal aborted, so subscriptions opened and closed under one long-lived signal each kept their callbacks alive (100 closed subscriptions left 100 listeners). Aborting the signal still closes every live subscription.
