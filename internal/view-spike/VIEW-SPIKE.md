# VIEW-SPIKE — first-party view layer gate (June 2026)

The de-risking spike the velo-era RFC called for, run with this repo's kill-gate discipline
(see BENCHMARKS.md honesty bar for the two prior gates that killed their features).

## What was built (throwaway, ~170 LOC)

- `src/signals.ts` — fine-grained signals core: `signal` / `computed` / `effect`, auto-tracking
  with per-run re-tracking (the branch-switching case naive cores fail — test-pinned, 5/5).
- `src/bind.ts` — declarative DOM binder: server renders plain HTML (the `@nifrajs/web-vanilla`
  adapter), the client attaches behavior by walking `data-bind-text/show/on` attributes. No VDOM,
  no hydration re-render, no component re-execution — markup IS the serialization format.

## The measurement (the gate)

Same counter island, `Bun.build` minify + gzip:

| | client JS (gz) |
| --- | ---: |
| **view-spike counter (signals + binder + demo)** | **0.47 KB** |
| solid-js/web minimal island (public figure) | ~4.0 KB |
| nifra+Solid full page hydration (SSR-BENCHMARKS client-JS column) | 6.0 KB |

Spike = **12% of a Solid island, 8% of the full-page bundle**. Not measured (needs a browser
harness): update latency and time-to-interactive — fine-grained effects are the same complexity
class as Solid's, so bundle is the differentiating axis at island scale.

## Verdict

- **Full first-party JSX engine (`@nifrajs/view`): still NO.** Unchanged from the original
  analysis, reinforced by this repo's perf findings — engines win by deleting a fat baseline, and
  Solid's baseline is already thin. Months of compiler work to tie an incumbent, then years of
  production-trust tail. The five adapters stay.
- **The middle path: GATE PASSED, decisively.** For island-class interactivity (counters,
  toggles, compare drawers, tab strips — everything a content/SEO product like the hotel
  comparator needs), signals + attribute binder delivers an ~8× bundle win over the smallest
  framework island, with SSR handled by `@nifrajs/web-vanilla` at zero client cost.

## Recommended productization (small, scoped — days not months)

A `@nifrajs/islets` (working name) companion to `web-vanilla`:
1. the signals core as-is (+ microtask batching),
2. the binder grown to a closed, documented attribute set (`text/show/class/attr/on/list?`),
3. loader-data seeding — `data-island-state` JSON → signals, the "server loader → client signal
   with zero ceremony" integration angle that was always the only defensible reason to own any
   view code,
4. a `bench/size` row + a browser smoke in the examples.

Decision deferred to the hotel-comparator build: if its widgets fit the attribute set, build
`@nifrajs/islets` there against real product needs; if they outgrow it, that's evidence Solid
islands are the right tier for that product — both outcomes are wins over speculating.
