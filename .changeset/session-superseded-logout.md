---
"@nifrajs/auth": patch
---

In store mode, `destroy(c)` called with a cookie that a `regenerate()` rotation has already replaced ends the whole session family only within 60 seconds of that rotation, while the rotating response may still be on its way to the browser. After that it drops only the replaced ID, so a pre-login cookie kept elsewhere can no longer end the session that replaced it. A cookie naming the live session, and `destroy(c, session)` with a loaded session, end the family as before.
