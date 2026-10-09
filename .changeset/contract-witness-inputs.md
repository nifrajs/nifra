---
"@nifrajs/testing": major
"@nifrajs/mock": minor
"@nifrajs/core": minor
---

The adversarial contract laboratory witnesses and mutates declared `params` and `headers`. A `t` schema synthesizes them, the witness's `params` and `headers` override, and each is validated before any case runs, so a body or query case is rejected by the input it mutates rather than by a placeholder param or a missing header. An opaque params or headers schema without a witness is a `NO_WITNESS` gap; placeholders no longer stand in for it.

The laboratory never invents credentials: `authorization`, `proxy-authorization`, `cookie`, `x-api-key`, and names ending in `-key` or containing `token`, `secret` or `signature` come from the witness and `prepareRequest` only and are never mutated, and runtime-owned headers are never set. A schema that requires a credential the witness lacks is a `NO_WITNESS` gap naming it. Cookies are never synthesized: a route with a `cookies` schema needs `headers.cookie` in its witness, else a `cookies` gap. A params or header field typed as bare text is not a `NO_REJECTED_MUTATION` gap. `ContractTarget` adds `"headers"`, `"cookies"` and `"params"`.

`autoReflectJsonSchema` resolves zod from the project directory first, then from `@nifrajs/mock`. `explainAutoReflectJsonSchema` says why a zod schema stayed opaque (zod not resolvable, older than 4, or its converter threw), and a laboratory gap for such a schema carries the reason.
