---
"@nifrajs/core": minor
"@nifrajs/agent": patch
"@nifrajs/coding-agent": patch
"@nifrajs/testing": patch
"@nifrajs/web": patch
---

`@nifrajs/core/canonical-json` exports `canonicalJson(value)`: JSON text with object keys sorted by UTF-16 code unit, no whitespace, and `undefined` members left out. A `JSON.rawJSON` value is written verbatim. A value JSON cannot carry throws a `TypeError` instead of being written as something else: a non-finite number, an `undefined` or missing array item, a `Date`, `Map`, typed array or class instance, a function, a symbol, a bigint.

Route manifests and their signatures, project evidence, idempotency fingerprints, agent resume and registry digests, `canonicalJson` from `@nifrajs/coding-agent/orchestration`, agent-eval and certification digests, contract-lab and adversarial body comparisons, and server-component input keys all use this encoding. Their bytes for JSON data are unchanged, so stored manifests, signatures, fingerprints and digests still match. Where one of them used to write a non-JSON value lossily (a `Date` as `{}`, `NaN` as `null`, an `undefined` array item as an empty slot), it now throws. In contract-lab and adversarial runs, an expected body's `undefined` members are left out, so they match a response that omits those members.
