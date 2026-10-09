---
"@nifrajs/env": patch
---

`defineEnv()` no longer prints a variable's value when a bring-your-own validator quotes it. A valibot message such as `Invalid email: Received "sk_live_..."`, or a hand-rolled one that echoes its input, went into the startup error as is. The value is now replaced with `<redacted>`. The `env.*` helpers already wrote value-free messages and are unchanged.
