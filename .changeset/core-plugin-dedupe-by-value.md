---
"@nifrajs/core": patch
---

`use()` skips a named plugin or middleware bundle only when that same value is applied again. Two values built separately under one name - a second, stricter `bearer()`, `jwt()` or `ipRestriction()` before admin routes, or one inside a `group()` - are two plugins, and both apply. Framework capabilities named `nifra:*` (`websocket()`, `streaming()` and the like) still apply once however many copies are used.
