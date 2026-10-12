---
"@nifrajs/core": minor
---

`responseContract("enforce", { extra: "strip" })` drops the fields a `t` schema does not declare before validating, instead of failing the response: a schema exposing its JSON Schema as `jsonSchema` lists its declared keys, so the payload is projected onto them, nested objects, arrays and records included. A union is projected only when exactly one branch can hold an object. The default, `extra: "reject"`, is unchanged: a closed `t.object` still turns an extra field into a 500 whose log names the field. In `"warn"` mode the option makes the log name the fields enforcement would drop. The security guide's example claimed the stripped output for plain `"enforce"`; it now shows all three outcomes.

`merge()` now recompiles a merged route under the response contract and effect ledger the parent installed before the merge, when the route declares a response (or capabilities) and its own server installed neither. `group()` routes already inherited both, so the same `.use()` used to enforce a grouped route and let its merged twin leak. A route that resolved its own contract or ledger keeps it. This can change a response: a merged route whose payload carries fields its closed `t.object` does not declare now answers 500 under a parent's `responseContract("enforce")`, as a grouped one already did. The `merge()` JSDoc and the plugins guide list what a parent's `.use()` covers for each.

Route assurance policies gain a `hasResponse` selector (routes declaring a success `response` schema) and `baseline` rules, checked on every route they match in addition to the first-match rule that owns it. "Every route that declares a response enforces it" is one baseline entry: `{ name: "response-contract", match: { hasResponse: true }, require: [NIFRA_ASSURANCE.RESPONSE_CONTRACT] }`. A baseline rule does not classify a route, and its name shares the `rules` namespace.

`RouteCapabilityEvidence` carries an optional `uncoveredReason`, appended to the `provenance-uncovered` finding.
