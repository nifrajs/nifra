---
"@nifrajs/core": minor
---

Assurance rules can match on a route's declared capabilities, and a misspelled selector key is now an error.

```ts
{ name: "authenticated-write", match: { capabilities: ["db.write"] }, require: [NIFRA_ASSURANCE.AUTHENTICATED] }
```

A path glob is the wrong tool for "anything that writes must prove who asked": it breaks when a route
moves, and it cannot see a route that acquires the capability later. The declared tokens already reach
reflection, so a policy can be written against what a route DOES. Matches when the route declares any of
the listed tokens.

Every `create-nifra` template ships this rule, which is what stops a server function - a public POST
endpoint whose arguments the caller controls - from shipping unauthenticated.

The selector is rebuilt from an allowlist of known keys, so an unrecognised one used to be dropped
silently. A selector that loses its only constraint matches EVERY route, so the rule swallows
everything after it - in a policy whose first rule is the lenient one, a single typo disabled the rest
of the file. Unknown selector keys are refused rather than ignored.
