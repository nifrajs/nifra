# @nifrajs/image

## 2.13.0

## 2.12.1

## 2.12.0

### Minor Changes

- 2c004ca: The image handler now admits requests before it reads a source, and the queue is bounded. Previously
  the source was fetched and buffered first and only the codec work was limited, so every queued request
  held a full source buffer while it waited - unbounded, since nothing capped the queue. Two lanes
  replace the single semaphore: `sourceConcurrency` (default `concurrency * 2`) admits a request for its
  whole lifetime and bounds live source buffers, and the codec lane is taken only around probe and
  transform, so a slow remote origin can no longer occupy a CPU slot for the length of a network wait.
  Beyond `maxQueue` (default `concurrency * 16`) waiting requests, the handler answers
  `503 image_queue_full` rather than queueing without limit. The memory ceiling is now explicit:
  `sourceConcurrency * maxSourceBytes`, 160 MiB at the defaults.

## 2.11.0

## 2.10.0

### Minor Changes

- 15bffdd: Add request-bound data capability evidence, resumable bounded channel subscriptions, ISR tag
  invalidation for memory and KV stores, and dependency-free Open Graph image responses with an
  optional rasterizer seam.

## 2.9.1

## 2.9.0

## 2.8.2

### Patch Changes

- f7d68e8: Numeric limit options (body/payload byte caps, TTLs, cache sizes, concurrency, ISR revalidate windows) are now validated at construction and throw a `RangeError` on non-finite or out-of-range values instead of silently disabling the bound - a `NaN` cap previously made `size > max` comparisons fail open. JWT `requiredClaims` now checks own properties only, so inherited names like `toString` no longer satisfy a required claim. `@nifrajs/mcp-db` gates multi-statement input with a real tokenizer, bounds `run_query` materialization to `maxRows + 1` via a wrapping subquery, and skips SQLite planner pseudo-nodes when verifying the table allowlist. `nifra scaffold` refuses to write through symlinked route directories.

## 2.8.1

## 2.8.0

## 2.7.1

## 2.7.0

## 2.6.1

## 2.6.0

## 2.5.0

## 2.4.0

## 2.3.0

## 2.2.0

## 2.1.0

## 2.0.0

## 1.13.0

## 1.12.0

## 1.11.0

## 1.10.0

## 1.9.1

## 1.9.0

## 1.8.0

## 1.7.0

## 1.6.0

## 1.5.0

## 1.4.0

## 1.3.1

## 1.3.0

## 1.2.2

## 1.2.1

## 1.2.0

## 1.1.0

## 1.0.0

## 1.0.0-beta.4

## 1.0.0-beta.3

## 0.1.0-beta.2
