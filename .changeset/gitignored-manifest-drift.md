---
"@nifrajs/cli": patch
---

`nifra check` no longer reports server-manifest drift for a manifest git ignores. Such a file is a build output the build regenerates, so flagging it blocked the build that would have fixed it (the ISR template runs `nifra check` before its build).
