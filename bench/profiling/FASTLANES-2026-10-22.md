# General HTTP fastlanes

This pass removes redundant continuations from arbitrary route programs, including multiple hooks
and either validation order. It also lets eligible Bun native routes call the complete execution
plan directly. It does not impose the one-derive/one-before shape of the closed fused lanes.

Measurements compare saved built artifacts against main at
`fc3fb7a4c6e7bf780ed2532787d79ad110a0e959`, on macOS arm64, Bun 1.4.3 and Node 26.12.0.
The companion `fastlane-evidence-2026-10-22.json` records artifact hashes and compact results.
Raw profiles and rounds remain ignored under `bench/profiling/results/`.

## Changes retained

- After an actual pending stage, resume synchronous validation/hooks until the next promise.
  Multiple derives, before hooks, after hooks, async validators, and async handlers share this
  continuation machinery. Completed hooks and decorations are not replayed.
- Legacy `auth-before-validation` programs remain synchronous when their work is synchronous.
  Idempotency still waits for successful policy hooks before buffering input.
- Reuse the same handler/after continuation for both validation orders.
- Eligible Bun native handlers invoke the entire execution plan when closed fusion is unavailable.
  Validation, recovery, around hooks, ledgers, contracts, and error boundaries still execute.
- Native searches replace the per-character encoding pre-scan for queries. Encoded input keeps
  the existing URLSearchParams fallback, including repeated keys and malformed escapes.
- Custom body-validator throws reject outside the JSON parser's catch, reaching the lifecycle
  error boundary instead of being misclassified as malformed JSON.
- A render failure after an asynchronous response-contract check reaches the lifecycle error
  boundary in both validation orders.

## Promise audit

`promise-audit.mjs` counts Node `async_hooks` PROMISE init events. Request construction is outside
the interval; the await driver is inside it. POST uses the delivered-byte bounded reader.
These are event counts, not exact allocations or throughput. Null-response and JSON-response
controls distinguish driver/Response overhead from framework continuations.

```sh
bun bench/profiling/build-fixtures.ts bench/profiling/results/candidate
node bench/profiling/promise-audit.mjs bench/profiling/results/candidate/fixture-entry.js
```

PROMISE init events per request, Node 26.12.0. Every count was identical across two runs.

| Case | main | final |
| --- | ---: | ---: |
| driver-control | 2 | 2 |
| driver-json | 3 | 3 |
| auth-before-validation-sync | 7 | 3 |
| auth-before-validation-async-query | 10 | 6 |
| validate-before-auth-sync | 3 | 3 |
| validate-before-auth-async-query | 10 | 6 |
| authenticated-auth-before-validation-async-query | 10 | 6 |
| authenticated-validate-before-auth-async-query | 8 | 6 |
| auth-before-validation-async-derive | 9 | 5 |
| auth-before-validation-body-async-handler | 15 | 15 |
| validate-before-auth-async-derive | 9 | 5 |
| validate-before-auth-body-async-handler | 17 | 15 |
| realworld-get | 3 | 3 |
| closed-get | 3 | 3 |
| closed-post | 9 | 9 |
| generic-get | 3 | 3 |
| generic-post | 15 | 11 |

Both validation orders now produce the same count on each async path above. A separate probe of
async before hooks, async handlers, and async after hooks on GET found 5 events in the final build
for both orders, against 7-9 on main.

Actual body I/O, asynchronous validators/hooks, contracts, admission, idempotency, and response
observers may require promises. Error continuations retain rejection handling. The timeout race
and cancellation paths remain intact. Request/response hook continuations already avoid awaiting
synchronous hooks; cold error/observer/shutdown paths were inspected without changing their order.

## Coverage and deliberate fallbacks

| Feature | Execution behavior |
| --- | --- |
| Arbitrary synchronous derives/before/after | Generic synchronous runner |
| Async validation, derive, before, handler, after | Resume at the next stage; no replay |
| Both validation orders | Same handler/after runner; policy order preserved |
| Headers, cookies, params, body, query | All five validation stages retained |
| Decorations, around, recovery, onError, thrown Response | Complete plan retained |
| Response contracts and ledgers | Complete plan retains enforcement and recording |
| Static and parameter Bun routes | Full plan may use native admission without closed fusion |
| Timeout, capacity admission, finalized/complex response hooks | Existing matched admission path |
| Inbound deadline header | Per-request fallback to deadline admission |
| Idempotency | Existing preparation/gate path; excluded from native table |
| Rewriting request hooks, mounts, client-IP trust, WebSockets | Existing portable dispatcher |
| Untrusted body framing | Delivered-byte cap; no synthetic trusted framing |

The regression matrix covers both orders, seven async-boundary combinations, and Web, Node-direct,
and real Bun HTTP. Additional native/portable tests cover poisoned bodies, byte limits, raw body
reads, deadlines, contracts, recovery, thrown errors, and rendering failures. The table lists
features each lane supports; it does not measure how many applications use a given lane.

## HTTP A/B

The generic worst-case app (`BENCH_GENERIC=1`) served from main and from the candidate source,
loaded with `oha -c 50`, count-bounded. Each workload ran 12 interleaved rounds: six with main
booted first and six with the candidate booted first, alternating run order within each pair.
Values are candidate/main requests per second. Absolute rates are omitted because the host's
power source changed during the runs.

| Workload | Bun geomean | Bun range | Node geomean | Node range |
| --- | ---: | ---: | ---: | ---: |
| GET, 3 hooks + 3 params + query + dynamic headers | 1.011 | 0.998-1.029 | 1.006 | 0.977-1.042 |
| POST, 10 KiB nested body | 1.020 | 1.004-1.028 | 1.001 | 0.983-1.024 |
| POST, 66 KiB nested body | 1.005 | 0.964-1.033 | 1.000 | 0.991-1.011 |

On Bun, GET and the 10 KiB POST improve in both boot orders. The 66 KiB POST disagrees between
boot orders and is inconclusive. Node is within noise for every workload. These handlers are
synchronous, so the async-handler rows of the promise table are not exercised here.

## Experiments rejected

- Folding the body and synchronous tail into one reader callback removed two more promise events,
  but did not improve nested POST HTTP throughput and complicated error handling and bundle size.
  Capturing validation-loop indices also regressed GET controls; lifting the closure fixed that
  particular regression. The body-fold optimization is not retained.
- A preflight-only CORS skip produced no established Node HTTP improvement and added bundle cost.
- Inline/shared array-record guard traversals improved flat record arrays but regressed scalar,
  mixed, nested, or deep controls. The production prototype guard is unchanged.
- Simplifying suspicious-key comparisons, native-header lookup shortcuts, and request-target
  regex changes did not meet the cross-shape/cross-runtime performance requirement.

On the large Bun POST profile, the unchanged prototype walk accounts for roughly 35% of sampled
time. The profile includes sampler overhead and native frames; that percentage is attribution,
not a predicted throughput gain. Rejecting poisoning remains the default. Disabling checks is
not included in the reported default Nifra results.

The A/B ratios compare Nifra with itself and do not establish wins over other frameworks. These
bounded valid-request stress cases are not an absolute worst case for every application.
Published benchmark datasets are unchanged.
