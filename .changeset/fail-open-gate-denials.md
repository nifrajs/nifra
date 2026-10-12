---
"@nifrajs/cli": patch
---

NF-S001 accepts more ways a gate's `catch` denies. A returned object whose `ok`, `allowed`, `authorized`, `authenticated`, `valid`, `success` or `granted` field is `false` is a denial, and so is an `authenticate…` function returning `null`, `undefined` or nothing. A `check…`/`verify…`/`ensure…`/`validate…` name is a gate only when the security word ends the name or a word in it, so `validateTokenizer`, `checkAccessibility` and `validateOriginalUrl` are no longer gates while `checkPermissions` and `verifySignatures` still are.
