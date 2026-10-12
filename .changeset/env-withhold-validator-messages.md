---
"@nifrajs/env": patch
---

When a BYO validator (zod, valibot, `t` or your own) refuses a variable that is set, `defineEnv` now reports `KEY: is invalid (the validator's message is withheld, since it may quote the value)` instead of the validator's own message. Before, it showed that message with the exact value replaced by `<redacted>`, which missed a value the validator had escaped (a JSON-quoted string with `"` or `\`), cut short, or changed in case, so part or all of a secret reached the startup error. A refused unset variable still shows the validator's message, and the `env.*` helpers still give their value-free reasons.
