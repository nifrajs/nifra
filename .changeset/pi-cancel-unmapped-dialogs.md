---
"@nifrajs/pi": patch
---

`PiBackend` now answers an extension's `select`, `input` or `editor` dialog, or a `confirm` that arrives outside a turn, with `cancelled: true` straight away. These were ignored before, so an extension awaiting one without its own timeout held the turn open. A `confirm` during a turn still surfaces as `approval.required`.
