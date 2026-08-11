---
"@nifrajs/core": minor
"@nifrajs/schema": minor
---

Routes and contract operations accept a `headers` schema, validated at the boundary alongside
`body`, `query`, and `params`. Field names are materialized lower-case onto a null-prototype record
before validation, so a hostile field name (`__proto__`, `constructor`) cannot reach
`Object.prototype`, and repeated fields arrive already comma-joined by the platform. The validated
result is available to the handler as typed data instead of ad-hoc `c.req.header(...)` reads, and a
failure answers the same flat `400` as any other input-validation failure.

The section flows through the rest of the surface: contract diffs report `headers` as its own
breaking-change section, and OpenAPI generation emits the schema as `in: header` parameters.
