---
"@nifrajs/coding-agent": patch
---

A run cancelled while a dispatch transition is in flight stays cancelled. `complete`, `retry` and `deadLetter` on the durable jobs dispatch store checked the entry, awaited the job store, then wrote their terminal state over a `cancel` that had been accepted in between; they now recheck after the await and report `cancelled`. A dispatch cancelled while its lease was being issued is no longer handed out.
