---
"@nifrajs/core": minor
---

Assurance rules can match a CLASS of capability rather than a list of token names.

```ts
{ name: "authenticated-write", match: { access: "write", zone: "domain" }, require: [AUTHENTICATED] }
```

Naming exact tokens is precise but closed. A rule listing `db.write` does not cover `storage.write`, so
every policy has to enumerate every write in the system, and a capability introduced next year escapes
the rule until someone remembers to widen it. `access` and `zone` are read from the capability
definitions, so the rule is keyed on what the capability IS - a new token is covered the day it is
declared.

Both constraints must hold for the SAME capability: a route that reads business state and writes an
audit log does not satisfy `{ access: "write", zone: "domain" }` by combining halves of two tokens.

The selectors resolve through the capability definitions, so `evaluateRouteAssurance` takes them via a
new third argument (`{ definitions }`) and `defineAssuranceConfig` refuses a policy that uses them
without a `capabilities` block. Without definitions such a rule could only ever match nothing - and a
rule that matches nothing does not fail, it lets the route fall past to whatever laxer rule comes next.
