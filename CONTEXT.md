# Nifra Context

Nifra is a contract-first TypeScript framework whose public modules keep request handling portable while private platform modules add durable production policy.

## Language

**Route assurance**:
A build-time proof that every reflected route is classified by policy and carries the enforcement evidence that classification requires.
_Avoid_: Middleware checklist, security annotation

**Assurance evidence**:
A reflection-safe fact emitted by the same module that installs an enforcement mechanism, scoped exactly as that mechanism is applied.
_Avoid_: Claim, tag

**Assurance policy**:
An ordered classification of routes that defines required and forbidden assurance evidence; the first matching rule owns the route.
_Avoid_: Middleware configuration, route lint

**Contract witness**:
A transport-serializable request known to satisfy every declared input schema on one route; it may be synthesized from JSON Schema or supplied for an opaque Standard Schema.
_Avoid_: Mock payload, fixture

**Hostile mutation**:
A small change to a contract witness that the route's own Standard Schema validator has proved invalid before the request is executed.
_Avoid_: Random bad data, fuzz value

**Contract laboratory**:
An off-hot-path exercise that runs hostile mutations and declared-response conformance against one or more fetch runtimes, retaining stable case IDs and a replay seed.
_Avoid_: Integration test helper, schema fuzzer
