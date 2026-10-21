# Bun prototype-guard investigation - 2026-10-21

Nifra does additional work in the tested Bun POST comparison: it rejects prototype-poisoning
payloads before validation, while Elysia's default JSON parser accepts them. Disabling Nifra's
guard increased throughput by about 8-9% in the final paired POST control. Protection remains
enabled by default. The retained optimization reduces the guard's own work modestly; it does not
establish a measurable overall HTTP speedup or consistent superiority over Elysia.

## Retained change

Bun's cursor stack now clears each popped reference immediately and reuses its empty storage.
After a successful walk, at most 1,024 logical slots remain; larger arrays take the existing
length reset. Poison rejection still clears pending work immediately. An unexpected throw from
a custom parsed source is cleaned up before the next object walk. Traversal, key checks,
Unicode-escape handling, and reject/strip/ignore semantics are unchanged.

Node keeps its native array stack and unconditional entry reset. Skipping that reset improved
several ordinary helpers but repeatedly slowed the 20,000-level chain by about 7%. That Node
shortcut and all experimental batch traversal code were removed.

Ten balanced helper rounds, 50,000 operations per round except 1,000 for the deep chain, on Bun
1.4.3. These reuse parsed clean values and exclude parsing, Request creation, and HTTP:

| Shape | Before ns | After ns | Change in guard time |
| --- | ---: | ---: | ---: |
| 88 records | 1,148 | 1,096 | -4.5% |
| 560 records | 6,706 | 6,416 | -4.3% |
| Small nested tree | 67.7 | 65.3 | -3.5% |
| 20,000-level chain | 105,167 | 103,039 | -2.0% |
| Scalar array | 3,133 | 3,139 | +0.2% |
| Mixed array | 3,144 | 3,166 | +0.7% |

The last two are approximately neutral. Final Node 26.12.0 controls are also approximately
neutral: the large record array is +0.1% in helper time, the deep chain +0.1%, and the small nested
tree +0.3%. Scalar/flat differences are a few nanoseconds and do not establish an HTTP effect.

Instrumentation of an isolated guard bundle found zero stored body references after successful
walks, poison rejection, and a clean request following a custom-source exception. A 560-record
walk retained 560 cleared logical slots; a 2,048-record walk reset to zero. This does not measure
native backing capacity, RSS, retained process heap, or cumulative allocated bytes.

## Actual Bun HTTP comparison

Both Nifra versions use equally bundled factories and the same server entry. The generic workload
uses three hooks, parameterized routes, validation, and dynamic headers. Each peer has three
untimed warmup batches per workload, then eight rounds with rotating and reversing order at 50
connections. Each timed window completes 100,000 GETs, 30,000 small POSTs, or 10,000 large POSTs.
All measured requests completed with HTTP 200; response and rejection probes passed.

| Workload | Nifra before req/s | Nifra retained req/s | Elysia req/s | Nifra ignore diagnostic req/s |
| --- | ---: | ---: | ---: | ---: |
| GET | 108,679 | 110,383 | 108,899 | 109,868 |
| POST 10.4 KiB | 46,881 | 47,590 | 50,047 | 51,491 |
| POST 66.3 KiB | 11,949 | 11,985 | 13,014 | 13,109 |

These are the harness's selected median-throughput samples. The medians of same-round retained /
before ratios were +1.9% GET, +1.4% small POST, and +0.1% large POST. The guard is not involved in
the GET control, so these small differences do not establish an HTTP improvement. An earlier
repeat also found approximately neutral HTTP results.

Same-round ignore / reject ratios were +8.2% small POST and +9.3% large POST. These quantify the
throughput effect of the policy in these workloads, not a universal CPU percentage. The unguarded
large POST was close to Elysia in this run; that does not establish a consistent cross-framework
win. The earlier CPU profile's guard attribution is not a predicted throughput improvement.

## Tested policy differences

The behavior probe used Elysia 1.4.30 and Fastify 5.12.7. With passthrough body validation:

| Payload | Nifra default | Fastify default | Elysia default |
| --- | --- | --- | --- |
| Clean JSON | 200 | 200 | 200 |
| Own `__proto__` | 400 | 400 | 200, key reaches handler |
| Unicode-escaped `__proto__` | 400 | 400 | 200, key reaches handler |
| `constructor.prototype` | 400 | 400 | 200, shape reaches handler |

Elysia also accepted the poisoned request on the existing closed-schema benchmark route. A
closed schema may clean extra keys, so acceptance alone does not prove those keys reach every
handler. This is a measured difference in parser policy, not a claim that every Elysia app is
exploitable. JSON parsing itself creates data properties; downstream assignments and vulnerable
merges determine whether poisoning becomes an exploit.

Default benchmark results should retain the actual defaults and describe their protection.
The new optional `BENCH_BUN_UNGUARDED` control is explicitly labelled `nifra-unguarded`, and its
startup probe refuses to benchmark a factory whose opt-out did not take effect. JSON output now
preserves every round's samples and the warmup count.

## Rejected approaches and next opportunity

- Separate own-property probes, `Object.values`, and bounded recursion did not beat the current
  traversal across the tested shapes.
- A conservative native regex prefilter helped record-array parsing but slowed a 64 KiB
  string-heavy body about 42%. It was not retained, and switching away from Bun's native JSON
  reader was not justified.
- Processing records in place reduced array helper time about 15-18%. Broader controls exposed
  regressions up to about 46% on mixed arrays and 20% on deep chains. These versions were removed.
- The Node empty-reset shortcut's repeated deep-chain regression was also rejected.

The larger remaining opportunity is combining protection with trusted first-party compiled
validation. That requires proof covering every nested object and opaque branch, preserving 400
versus 422 behavior and strip semantics. Arbitrary Standard Schema validators, loose objects,
unknown values, coercion, and custom transforms cannot silently bypass the guard. No such bypass
or benchmark-validator rewrite was introduced here.

## Validation and evidence

2,850 Bun tests, 116 real Node tests, and four profiling contract tests pass (2,970 total).
`nifra check --json`, the core performance gate, scoped Biome, and `git diff --check` pass.
New cases exercise broad/mixed/nested inputs under all three policies, clean requests after
rejection, and recovery from an unexpected custom-source throw.

An initial broad Bun invocation also matched Node-only test files and failed two Node transport
cases under Bun. The corrected Bun directory selection and the intended real Node runner pass.

[Portable evidence](proto-evidence-2026-10-21.json) contains round samples, artifact hashes, policy
probes, logical stack checks, and rejected experiment data. [Reproduction commands](README.md)
describe the diagnostic options. Raw candidate code remains ignored under `results/pass3/`.
The published memory capture remains the earlier dated Node measurement; no new Bun allocation
or footprint result is inferred from this investigation.
