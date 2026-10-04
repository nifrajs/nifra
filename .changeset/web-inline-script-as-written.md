---
"@nifrajs/web": patch
---

`unsafeInlineScript()` code is emitted exactly as written, so a script with a comparison (`if (innerWidth < 600)`) runs instead of failing to parse, and server rendering matches what a soft navigation applies. Code containing `</script` or `<!--` (any case) is refused with a `TypeError`, both when the descriptor is built and when the head renders. Write `<\/script` inside a string literal instead. Inert `head.script` content (JSON-LD) is escaped as before.
