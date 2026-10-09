---
"@nifrajs/testing": patch
---

`generateRegressionTest` now adds a review banner when the emitted request body keeps numbers, booleans or object keys verbatim. Only string values are redacted, so a card number or an email used as a key went into the fixture with no prompt to check it.
