# @nifrajs/image

## 4.0.2

## 4.0.1

## 4.0.0

### Minor Changes

- def0172: Images are sized and served the way a viewer displays them, with a JPEG's EXIF orientation applied:

  - `imageDimensions()` and `readImageDimensions()` report a JPEG's displayed size. An `<Image>` of a phone photo stored landscape with orientation 6 now gets portrait `width`/`height`.
  - `sharpImageBackend()` turns the pixels upright before resizing (sharp's `rotate()`), and its probe reports the displayed size. Before, every resized or metadata-stripped photo with an orientation tag came out turned. `SharpLike` now includes `rotate()`.
  - `wasmImageBackend()` turns the decoded pixels upright before resizing and encoding. A codec that already turned a quarter-turn image is left as it is.

### Patch Changes

- fc2f019: `imageDimensions()` sizes a GIF the way browsers draw it: each side is the larger of the logical screen and the first frame. A GIF whose header declares a 1x1 (or 0x0) screen around a 10x20 frame now reports 10x20. When the first frame lies past the bytes read, the logical screen size is returned as before.
- a734fba: `renderOgImage()` and `ogImageResponse()` take CMS-shaped text. Line breaks and tabs are drawn as spaces, an empty optional `description` or `eyebrow` is treated as absent, and text past its limit ends with an ellipsis. Before, each of these threw. A missing title and a control character an SVG cannot hold are still errors.

  A revalidation of an unchanged card is answered `304` from the tag this process last sent for the same SVG and rasterizer, without rasterizing again, as documented.

- 031c33d: fix(runtime): preserve typed-array compatibility across Fetch runtimes and reject invalid request bodies at the runner boundary.

## 3.5.0

### Patch Changes

- d5b7c22: Harden request boundaries, error handling, resource limits, signing, and cross-runtime adapters for safer production releases.

## 3.4.0

## 3.3.0

## 3.2.0

### Patch Changes

- 7551709: Harden runtime boundaries and defaults: clean up subprocess abort listeners, support short Cloudflare
  KV sessions, bound and incrementally sweep the default memory cache, make image reads and cancellation
  safe, emit content-derived image validators, require trusted forwarded hosts, avoid caching dynamic SSR
  metadata, and reject invalid upload or image limits.

## 3.1.0

## 3.0.0

## 2.14.1

## 2.14.0

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
