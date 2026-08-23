# Nifra Response Inference and Type-Ergonomics Plan

Status: executed through Phases 0–5; Phase 6 closed as a measured no-go.

## Execution record — 2026-08-23

The high-value, scope-compatible work in this roadmap is implemented:

- Phase 0: the status-keyed response algebra, precedence rules, opaque-response behavior, and
  runtime/code-generation boundaries are now encoded in the public types and tests.
- Phase 1: literal `status(code, body)` inference preserves the status and body types with the
  existing allocation-free `PlainRender` runtime path.
- Phase 2: response variants propagate through `derive`, `beforeHandle`, `afterHandle`, `onError`,
  `around`, middleware, plugins, `.merge()`, `.tool()`, `.ws()`, and contract `implement()`.
- Phase 3: the typed client discriminates inferred success/failure statuses, while explicit schemas
  remain authoritative; OpenAPI accepts additive inferred response metadata without changing explicit
  route or contract output.
- Phase 4: `nifra openapi` performs optional build-time TypeScript inspection and converts supported
  response types to inert OpenAPI schemas. It never compiles or executes TypeScript at request time,
  and unsupported types are reported or left opaque.
- Phase 5: `.merge()` and contract-first composition are documented and covered as the supported
  large-application path. The existing single-chain ceiling is measured and documented rather than
  hidden behind a riskier builder rewrite.
- Phase 6: no AOT implementation was adopted. Current measurements show no meaningful dispatch or
  registration bottleneck that justifies cross-runtime build complexity. Nifra remains ahead of the
  repository's Elysia 1.x quick HTTP smoke benchmark. The repository does not currently contain an
  Elysia 2 benchmark matrix, so no Elysia 2 performance claim is made.

The full release gate remains blocked by pre-existing repository issues outside this implementation:
benchmark/Deno typecheck and formatting failures, existing static-response-header fixtures, an
undeclared benchmark import, a stale site manifest, and existing security-lint findings. Focused
tests, changed-package builds, and the core performance gate pass. These unrelated issues are not
silently changed as part of this roadmap.

## Goal

Close the high-value TypeScript and OpenAPI ergonomics gaps identified in the Elysia comparison without turning Nifra into Elysia.

The primary user-facing outcome is that ordinary routes should not need duplicated `response` and `errors` declarations merely to obtain precise client types or OpenAPI output:

```ts
app.get("/users/:id", (c) => {
  const user = findUser(c.params.id)

  if (user === undefined) {
    return status(404, { error: "not_found" })
  }

  return user
})
```

The intended inferred response map is:

```ts
200: User
404: { error: "not_found" }
```

Explicit schemas remain available for runtime response validation, strict public contracts, and precise schema constraints.

## Design boundaries

These decisions are fixed unless later benchmarks or compatibility requirements provide strong evidence to revisit them:

- Preserve multi-runtime support: Bun, Node, Deno, Cloudflare Workers, and other Fetch-compatible runtimes.
- Preserve Nifra's schema-first input validation model.
- Do not introduce runtime `new Function`, runtime TypeScript compilation, or generated handler source code.
- Keep the allocation-free `PlainRender` response path for early exits.
- Treat explicit `response` and `errors` schemas as authoritative runtime contracts when supplied.
- Make inference additive and backwards-compatible; existing explicit route declarations must continue to work.
- Do not promise that arbitrary TypeScript types can become valid JSON Schema.
- Do not claim Elysia 2 parity until the same benchmark matrix has been run against Elysia 2 beta/experimental builds.

## Current evidence

Relevant existing surfaces:

- `packages/core/src/server/runtime-core.ts` — `status()` currently accepts `number` and `unknown`, so status/body literals are lost.
- `packages/core/src/server/context.ts` — `RouteSchema.response` describes one success schema and `RouteSchema.errors` describes explicit status-keyed errors.
- `packages/core/src/server/registry.ts` — ordinary handler return types are already inferred; the fluent builder reaches a TypeScript instantiation ceiling around 95–100 routes.
- `packages/core/src/server/server.ts` — lifecycle hooks and `derive()` do not fully contribute early-response variants to route output types.
- `packages/client/src/result.ts` — declared errors already produce status-discriminated client failures.
- `packages/schema/src/openapi.ts` — explicit schemas are reflected, while inline app routes without a response schema currently receive a generic `200` response.

## Phase 0 — Freeze the response model and establish a benchmark baseline

### Objective

Define one response algebra that the server, registry, typed client, and OpenAPI generator all share.

### Work

- Define an internal status-keyed response representation, for example:

  ```ts
  {
    200: User
    201: CreatedUser
    404: NotFound
  }
  ```

- Decide and document how to represent:
  - 2xx success responses;
  - 3xx responses;
  - 4xx/5xx error responses;
  - undeclared statuses;
  - transport failures;
  - empty-body statuses such as `204`;
  - a bare `Response` whose body cannot be inspected.
- Define precedence between inferred responses and explicit `response`/`errors` schemas.
- Decide whether a typed status result returned from a lifecycle hook is merged into the route response map or terminates that branch only.
- Document that arbitrary `throw new Response()` cannot be statically inspected. Provide a typed helper or explicit contract where typed thrown errors are required.
- Build comparable benchmark fixtures for Nifra, Elysia 1.4.x, and Elysia 2 beta/experimental versions.
- Measure steady-state throughput, cold start, first request, route registration, memory, and bundle size where comparable.

### Acceptance criteria

- A written response-map design exists before public type changes begin.
- Existing explicit `response` and `errors` routes have unchanged meaning.
- A bare `Response` remains safe and intentionally opaque.
- Benchmark results clearly separate Elysia 1.x and Elysia 2 results.

## Phase 1 — Add literal status/body inference

### Objective

Make `status(404, body)` preserve both the literal status and the body type without changing the hot runtime path.

### Work

- Change the public type of `status()` to preserve literal generics:

  ```ts
  status<const Code extends HttpStatus, const Body>(
    code: Code,
    body: Body,
    init?: StatusInit,
  ): TypedStatusResponse<Code, Body>
  ```

- Add an internal type brand carrying `Code` and `Body`.
- Keep `PlainRender` runtime behavior unchanged.
- Correctly model optional bodies and no-body statuses.
- Preserve header typing and existing status-range runtime validation.
- Extract typed status results from unions returned by handlers.
- Define behavior for a literal union such as `404 | 409` and for a dynamic `number`.
- Decide whether a typed helper is needed for thrown status responses.

### Acceptance criteria

- `status(404, { error: "not_found" })` is visible to TypeScript as status `404` with that body shape.
- A route returning a normal body and a typed `status()` result exposes both variants.
- No `Response` allocation is added to the plain status path.
- Existing callers of `status()` continue compiling unless they depended on intentionally broad `unknown` behavior.

## Phase 2 — Propagate response variants through lifecycle hooks

### Objective

Ensure early responses and replacements from Nifra's lifecycle system appear in the route's inferred response map.

### Work

- Update types for `derive`, `beforeHandle`, `afterHandle`, and `onError`.
- Preserve `derive()` context extension inference while excluding response carriers from the context-extension object type.
- Include `beforeHandle` short-circuit responses.
- Include `afterHandle` replacements and transformed responses.
- Include typed responses produced by error handlers.
- Cover middleware, mounted apps, route groups, and `.merge()`.
- Define how multiple hooks combine response unions.
- Ensure response inference does not widen unrelated handler return types to `unknown`.

### Acceptance criteria

- A typed `status()` returned from any supported lifecycle stage appears in the client-visible route response map.
- Context properties added by `derive()` remain correctly typed.
- Runtime short-circuit behavior is unchanged.
- Hook type fixtures cover success, early failure, replacement, and error-handler paths.

## Phase 3 — Integrate response maps with the typed client and OpenAPI

### Objective

Make inferred status variants useful to consumers without requiring duplicated response/error declarations.

### Typed client work

- Extend `RouteInfo` with a response-map representation while preserving existing `output` and `errors` compatibility fields where necessary.
- Make known success statuses narrowable when the route provides them.
- Make `status === 404` narrow the failure body to the inferred or declared 404 type.
- Merge inferred status responses with explicit `schema.errors` according to the Phase 0 precedence rules.
- Preserve an `unknown` fallback for undeclared statuses.
- Keep existing declared-error behavior from `packages/client/src/result.ts`.

### OpenAPI work

- Emit multiple inferred response entries when response schemas are available.
- Continue reflecting explicit `response` and `errors` schemas exactly.
- Do not pretend that a TypeScript-only inferred type is a runtime validator.
- Preserve existing operation overrides and contract-first OpenAPI behavior.
- Add a clear distinction between:
  - inferred client typing;
  - generated documentation schema;
  - runtime validation schema.

### Acceptance criteria

- A normal route can omit duplicated `response`/`errors` declarations and still produce precise client response types.
- Explicit schemas override inference where configured.
- OpenAPI output is deterministic and backwards-compatible for existing explicit-schema routes.
- Undeclared or opaque responses remain safely typed as unknown rather than being guessed.

## Phase 4 — Add optional build-time TypeScript-to-JSON-Schema generation

### Objective

Provide the Elysia-style convenience of generating OpenAPI response schemas from inferred TypeScript return types, without adding runtime code generation.

### Work

- Define a public build-time schema-provider seam.
- Add a CLI or build integration that reads route declarations/types from the generated type graph or route manifest.
- Convert supported TypeScript types to JSON Schema 2020-12/OpenAPI-compatible schemas.
- Convert literal status-response brands into OpenAPI response entries.
- Support at minimum:
  - primitives;
  - literals;
  - objects and optional properties;
  - arrays and tuples;
  - unions;
  - discriminated unions;
  - documented common built-ins.
- Emit warnings or safe fallbacks for unsupported, generic, recursive, or opaque types.
- Keep server-only modules out of browser bundles while inspecting types.
- Make generation deterministic and suitable for CI snapshots.
- Decide whether generated schemas are documentation-only or can optionally feed generated runtime validators. Do not imply runtime validation unless a validator is actually generated and wired in.

### Acceptance criteria

- A route with inferred response types can produce useful OpenAPI output without a duplicated response schema.
- Unsupported types fail visibly or degrade safely; they are never silently misrepresented.
- No runtime `new Function` or runtime TypeScript compiler is required.
- Explicit schemas remain the escape hatch for exact validation and constraints.

## Phase 5 — Improve large-route TypeScript ergonomics

### Objective

Raise the practical route-count ceiling and make large applications easier to compose without promising that TypeScript has no limits.

### Immediate work

- Document route-group composition as the preferred large-app pattern.
- Ensure `.merge()` preserves exact paths, methods, parameters, response maps, and client types.
- Improve `implement()` guidance and examples for contract-first applications.
- Add diagnostics or documentation when a single fluent chain becomes too large.

### Type-architecture investigation

- Separate per-route handler-context inference from accumulated registry growth.
- Prototype a staged route collector or two-phase registration model.
- Measure TypeScript compile time and memory at 100, 250, and 500 routes.
- Preserve exact path-parameter inference and typed-client generation.
- Adopt the redesign only if it materially improves real applications without making the public API harder to understand.

### Acceptance criteria

- Existing `.merge()` and contract-first applications remain valid.
- Large applications have a documented, supported composition path.
- Any new builder architecture has type fixtures proving no regression in route precision.
- Documentation avoids an absolute “no TypeScript limit” claim.

## Phase 6 — Optional Elysia 2-style AOT investigation

### Objective

Determine whether build-time route/dispatch precomputation provides a meaningful Nifra benefit. This is an investigation, not a guaranteed implementation phase.

### Start condition

Proceed only if Phase 0 measurements show a meaningful Nifra problem in cold start, first request, registration time, memory, or bundle size.

### Possible work

- Generate a build-time route manifest.
- Precompute route matching and response/schema metadata.
- Add an optional startup/precompile mode.
- Preserve runtime fallback for dynamic route construction.
- Evaluate an unplugin/build integration only if it works across Nifra's supported environments.

### Hard constraints

- No runtime `new Function`.
- No Bun-only implementation.
- Must work or fail safely across Bun, Node, Deno, and Cloudflare Workers.
- Must preserve dynamic composition and normal `app.fetch` behavior.

### Acceptance criteria

- A measured benchmark improvement justifies the complexity.
- Build output remains deterministic and debuggable.
- Unsupported/dynamic applications retain a correct fallback.
- If there is no meaningful gain, record a no-go decision and close the investigation.

## Final verification and release gate

Add or update:

- TypeScript declaration fixtures for status, errors, hooks, client narrowing, and OpenAPI inference.
- Runtime tests for returned and thrown responses.
- Lifecycle short-circuit and replacement tests.
- OpenAPI snapshot tests.
- TypeScript-to-JSON-Schema supported/unsupported-type fixtures.
- 100/250/500-route compiler stress tests.
- Bun, Node, Deno, and Workers compatibility tests where applicable.
- Benchmark comparisons against the same Elysia 1.4.x and Elysia 2 beta/experimental matrix.
- Documentation and migration notes explaining when explicit schemas are still required.

Run the repository gates:

```bash
nifra check --json
bun run check:release
```

If the repository's assurance/capability configuration is present, also run the configured `nifra assure` and capability checks.

## Explicitly out of scope

- Replacing Nifra's schema-first input validation model.
- Requiring users to adopt Elysia-style macros.
- Reactive-cookie syntax parity.
- Elysia plugin/ecosystem compatibility.
- Runtime handler code generation or `new Function`.
- Automatic runtime validation from arbitrary erased TypeScript types.
- Bun-only optimization work.
- OpenTelemetry parity; Nifra already has first-party `@nifrajs/otel` support.
- Claiming Elysia 2 benchmark parity before the comparison matrix is executed.

## Recommended execution order

1. Phase 0 — response model and benchmark baseline.
2. Phase 1 — typed `status()`.
3. Phase 2 — lifecycle propagation.
4. Phase 3 — typed client and OpenAPI integration.
5. Phase 4 — optional build-time schema generation.
6. Phase 5 — large-route TypeScript ergonomics.
7. Phase 6 — AOT investigation only if benchmark evidence supports it.

Phases 1–3 deliver the core productivity improvement. Phases 4–5 remove most remaining duplicated documentation/type work. Phase 6 is deliberately conditional.
