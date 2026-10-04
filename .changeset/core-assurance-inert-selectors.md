---
"@nifrajs/core": patch
---

An assurance rule whose selector can match no route is refused when the policy is defined: an empty `methods` or `paths` list, a `capabilities` entry that is not a valid capability id, and, in `defineAssuranceConfig` with a capability policy, a selected capability that policy does not define. Each made the rule inert, so its routes fell through to the next, laxer rule.
