# Performance budgets

Three budgets, three release gates. The byte and timing checks are deterministic enough to run in the
local release plan; noisy shared-runner throughput remains outside the GitHub workflow.

## 1. Middleware chaining tax - `bench/http/middleware-overhead.ts`

The per-request cost of the compiled per-route chain (`derive` + `beforeHandle` + `afterHandle`) is
measured in-process (no network - route match to serialize only). Run
`bun run check:middleware-overhead` to enforce both limits:

- middleware overhead: at most **50%** slower than the bare route;
- middleware overhead: at most **250 ns/req**.

Absolute req/s moves with machine load, so the benchmark prints the delta and the release gate checks
only these generous ceilings. The measured stack is one `derive` (header read), one pass-through
`beforeHandle`, and one pass-through `afterHandle` - it pins chaining cost, not any specific middleware.

Latest local results (Bun 1.4.2, macOS arm64, 2026-09-24):

| Row | Throughput | Delta vs bare |
|---|---|---|
| bare route (`GET /users/:id`) | 2,752,672 req/s | - |
| + `derive` + `beforeHandle` + `afterHandle` | 2,193,784 req/s | 20.3% / 93 ns per req |

The check is release-plan-only (`workflowRequired: false`) because shared CI timing is noisy. A
failure is a regression signal requiring an explained benchmark diff before the threshold moves.

## 2. Bundle size - `bench/size/run.ts --check` (`check:size`)

Gzip ceilings per matrix row are set to measured plus approximately 0.2 KB headroom. This includes
the `nifra-agent-review` leaf-import row (ceiling 5.2 KB gz): the review leaf must stay
dependency-minimal and off the request path. It is composed by `nifra review`, never imported by
`core`, `client`, `schema`, `web`, or any runtime adapter. A leaf budget break means a new runtime
dependency or kernel reachability - a regression, never a repricing.

## 3. Edge cold-start proxy - `scripts/check-edge-startup.ts` (`check:edge-startup`)

Cold-start time itself varies by deploy target, so the release plan checks a fresh-process import-time
proxy for the published edge entrypoint and the Workers source entrypoint. Each target is imported in
five fresh Bun processes and its median must be at most **25 ms**. The gate also fails when an expected
entrypoint is missing or cannot import.
`@nifrajs/edge` is measured from its built `dist/index.js`; `@nifrajs/workers` publishes source and is measured from `src/index.ts` because it has no dist artifact.

This timing proxy catches accidental heavy imports, synchronous startup work, and runaway allocation;
it cannot prove the absence of every top-level side effect. `check:public-boundary` remains the
authority for import legality and edge portability. The startup check is release-plan-only
(`workflowRequired: false`) because process timing is noisy on shared CI.

Baseline (2026-09-24, Bun 1.4.2, macOS arm64): `@nifrajs/edge` fresh-import median
2.3 ms; `@nifrajs/workers` fresh-import median 1.7 ms (five Bun processes each).

Separate core import measurement (30 fresh Bun processes): `@nifrajs/core` 4.148 ms,
`@nifrajs/core/server` 4.079 ms, root delta 0.069 ms.
