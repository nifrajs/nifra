# HTTP optimization follow-up - 2026-10-21

Two changes are retained: native URL delimiter searches and lower-allocation Node body reading.
The measurements support less work on long URLs and less POST allocation churn. They do not
establish a consistent throughput win over Fastify or Elysia. The remaining largest deficit in
the final bounded generic matrix is Bun's large POST against Elysia, at 8.4%.

## Retained changes

- `urlPartsOf`, `Server.routeAndRun`, and Node's origin-form splitter use native `indexOf`
  searches for query and fragment delimiters. A fragment before a question mark still ends the
  URL, and later question marks remain part of the query. This removes the character-by-character
  JavaScript scan without changing query decoding, parameter handling, or routing policy.
- Node body reads store their chunks, mapper, and promise callbacks in an isolated per-read
  object. The data callback binds directly to its accumulator, and one completion callback handles
  end/error/close. Listener cleanup, consumed-body replay, mapping failures, and aborted-read
  rejection remain covered by the real transport tests. The reader does not pool request state.

The URL change applies across runtimes. The body-reader change applies to the Node transport.
No validation, authentication, byte-limit, or prototype-poisoning check was removed.

## Bun response-production A/B

Eight balanced rounds against the immutable pre-edit bundle, 100,000 GETs per round. GET reuses a
bodyless Request and does not drain the response. POST creates a fresh Request and uses 20,000
requests per round. These are producer costs, excluding HTTP transport; smaller is better.
Ordinary medians average the two central observations for an even sample count. Exact values and
all round samples are in the evidence file.

| Producer case | Before ns/request | After ns/request |
| --- | ---: | ---: |
| Real-world GET | 2,648 | 2,646 |
| Real-world POST, including fresh Request | 14,807 | 14,922 |
| Closed GET | 990 | 943 |
| Closed encoded | 1,380 | 1,348 |
| Closed long query | 1,902 | 1,467 |
| Generic GET | 1,097 | 1,077 |
| Generic encoded | 1,453 | 1,398 |
| Generic long query | 2,047 | 1,615 |

The long-query cases improve by 21-23%. Closed/generic short and encoded cases show smaller
improvements. Real-world GET is neutral and POST differs by +0.8%, which is too small in these
local samples to establish an ordering. The query decoder itself is unchanged; an earlier attempt
to optimize that decoder regressed encoded queries and was rejected.

## Node allocation and timing

The final allocation capture uses four balanced rounds of 100,000 real-world POSTs after 100,000
warmup requests per peer. V8 samples allocations at 16 KiB and includes objects collected by both
minor and major GC. This measures cumulative sampled JS allocations, including short-lived
objects; it excludes some native allocations and is not retained heap or RSS. Median sampled
allocation falls from 10,728 to 10,450 bytes/request: 278 fewer bytes, or 2.6%.

Timing repeats produced small gains and losses. The final long POST timing repeat was affected
by a background CPU spike and elevated host load in its late rounds, so it is retained in the
evidence as a diagnostic, not used to claim a speedup. The earlier generic A/B showed GET +2.1%,
10.4 KiB POST -0.5%, and 66.3 KiB POST +0.3%; it preceded removal of the data forwarding call.
These small POST differences do not establish a regression-free speedup. Keep the allocation
benefit separate from any throughput claim.

## Final generic HTTP comparison

`BENCH_GENERIC=1 BENCH_RUNS=6 BENCH_SCALE=30` adds the same extra before hook to every peer and
excludes Nifra's closed-shape lifecycle fusion. A test inspects the actual compiled GET/POST plans.
The fixture has three dynamic path parameters, query validation, lifecycle hooks, dynamic response
headers, and nested JSON validation. Peer order rotates and reverses, including all three positions
on Node. Response and rejection probes run before load; every measured request must return 200.

Six interleaved rounds, 50 connections, 30,000 GET / 9,000 small POST / 3,000 large POST requests
per timed window on macOS ARM64. Throughput ratios use each peer's selected median-throughput
sample. Positive means Nifra is faster. These are local diagnostic results, with no confidence
interval or claim of stable ordering for small differences.

| Runtime / peer | GET | POST 10.4 KiB | POST 66.3 KiB | Large POST p99, Nifra / peer |
| --- | ---: | ---: | ---: | ---: |
| Bun / Elysia | -4.3% | -7.4% | -8.4% | 8.41 / 7.56 ms |
| Node / Fastify | +0.4% | +4.4% | +7.2% | 14.04 / 15.24 ms |
| Node / Elysia | +33.9% | +24.6% | +2.8% | 14.04 / 16.20 ms |
| Deno / Elysia | +23.6% | +13.4% | +5.5% | 7.43 / 7.36 ms |

Bun 1.4.3, Node 26.12.0, Deno 2.9.7, Fastify 5.12.7, Elysia 1.4.30, Node adapter 1.4.5.
Nifra uses workspace artifacts. As in the existing throughput harness, Nifra's Node fixture is
bundled while its Node peers load native modules; the separate memory protocol removes that
packaging difference.

This bounds a valid-request generic stress case. It is not an absolute worst case over async hooks,
response validation, streaming/chunked input, route churn, error traffic, or sustained overload.
Faster throughput also does not guarantee a lower p99, as the Deno large-POST row illustrates.

## Memory benchmark

`bun run bench:memory:update` captures and updates the local benchmark-page data, guarded by the
repository's pinned-runtime and host-load checks. It does not deploy the website. All five peers
load native modules in fresh Node processes. Each gets five process rounds with readiness probes,
50,000 GETs, then 50,000 POSTs, at 50 connections. Two collections precede each snapshot.

The benchmark page shows ready / after-GET / after-POST RSS, peak RSS, and retained POST heap,
plus the observed post-POST RSS range. It records runtime, hardware, versions, source revision,
and a workspace artifact digest. The digest must stay unchanged during capture. Incomplete,
duplicate, mixed-packaging, and profiled data cannot be published.

The final capture passed both host-load guards, with the final workspace artifact digest. MiB
values below are medians across the five fresh processes:

| Framework | After GET RSS | After POST RSS | Peak RSS | POST heap |
| --- | ---: | ---: | ---: | ---: |
| Nifra | 75.0 | 77.5 | 129.7 | 15.4 |
| Fastify | 81.5 | 85.2 | 137.9 | 16.7 |
| Elysia | 76.0 | 146.3 | 196.4 | 11.1 |
| Hono | 79.3 | 143.4 | 197.5 | 8.0 |
| Express | 79.1 | 84.7 | 141.2 | 14.7 |

An earlier complete native-module repeat measured post-POST RSS at 79.8 / 82.7 / 156.6 MiB for
Nifra / Fastify / Elysia. The repeat variation matters, particularly for small memory differences.
Nifra's lower RSS here does not imply that it has the smallest retained JavaScript heap.

RSS includes the runtime and native memory. Peak RSS is the OS high-water mark since startup.
Retained heap and per-request allocation churn are separate quantities; none of these short runs
is a leak test. The memory table currently covers Node. Its data and method must not be presented
as a Bun or Deno memory result.

## Rejected experiments

- Query decoder native searches: encoded-query producer regression.
- JSON helper extraction: no allocation benefit.
- Shared callback state on native requests via Symbol: allocations increased.
- Mapped-JSON callback bridge: neutral or worse.
- Generic lifecycle argument/array-hoist cleanup: longer generic GET repeat was neutral, with
  earlier mixed results; restored the original code.
- Initial body-state data forwarding: removed the extra per-chunk call; data binds directly to
  the per-read accumulator in the retained implementation.

## Verification and reproduction

2,844 Bun tests, 74 real Node transport tests, and four measurement/compiled-plan tests pass.
`nifra check --json`, site assurance, site capability checks, and the core hot-path performance
gate pass. The site build renders all 80 pages, including the memory table. Scoped Biome and
`git diff --check` pass. Tests include encoded/long URL delimiters, interleaved readers, body caps,
chunked input, replay, parse errors, and early connection closure.

See [README.md](README.md) and [the memory protocol](../memory/README.md). Portable round data,
allocation results, final generic matrix, and memory medians are in
[optimization-evidence-2026-10-21.json](optimization-evidence-2026-10-21.json). Raw local profiles
remain ignored under `results/`. The [initial findings](FINDINGS-2026-10-21.md) describe the
pre-optimization investigation.

To establish a consistent ranking, repeat balanced runs on quiet Linux hardware with fresh
processes, complete success counts, per-round ratios, and confidence intervals. This workstation's
small timing differences are insufficient for that claim. The remaining Bun generic POST gap
needs its own allocation/validation profile before changing a correctness or security boundary.
