# HTTP memory footprint

Build the workspace packages first, then capture the authenticated GET/POST workload used by the
HTTP real-world benchmark:

```sh
bun run --filter '@nifrajs/core' --filter '@nifrajs/node' --filter '@nifrajs/middleware' build
bun run bench:memory
```

The Node matrix includes Nifra, Fastify, Elysia, Hono, and Express. Bun and Deno run those same
frameworks, plus a raw runtime server used as a local floor in the capture artifact. Nifra, Elysia,
and Hono use their runtime-native server fixtures on Bun and Deno; Fastify and Express use that
runtime's `node:http` compatibility. Raw runtime rows stay out of the website tables.

Each framework gets five fresh processes. Each process is correctness-probed, sampled after
readiness, driven through 50,000 GETs and 50,000 POSTs at 50 connections, then sampled after each
phase. All requests must complete with HTTP 200. Two forced collections precede each snapshot.
Framework order rotates between process rounds. Artifacts must stay unchanged during capture.

The Node command writes `bench/profiling/results/realworld-memory.json` (ignored). The update
command keeps each runtime's raw capture under `bench/profiling/results/<runtime>/`. RSS is the
whole resident process footprint, including the runtime and native allocations. Heap usage is
retained JavaScript memory. Peak RSS is the OS high-water mark since startup. These are not
allocation counts or a leak test. Deno uses a loopback control endpoint for snapshots; Node and Bun
use child-process IPC.

The website stores one capture per runtime. `bench:memory:update` runs Node, Bun, and Deno
sequentially on the same host, then merges each capture into the site dataset. This keeps the
runtime comparison on one machine. The benchmark CI adds one hosted-runner job per runtime; each
job measures its framework matrix on that runner and uploads the raw artifact with host metadata.
CI artifacts are useful for run-to-run checks; compare the committed cross-runtime website data,
which comes from the sequential same-host update, for host-sensitive memory differences.

To capture and update the local website dataset together:

```sh
bun run bench:memory:update
```

Or publish a previously captured local artifact into that dataset:

```sh
bun bench/memory/publish.ts bench/profiling/results/realworld-memory.json
```

For a Bun or Deno artifact, pass its runtime-specific path, such as
`bench/profiling/results/bun/realworld-memory.json`.

Publishing here updates local source data; it does not deploy a website. It requires a complete
runtime-specific matrix, at least three fresh processes per framework, at least 20,000 requests
per phase, and the repository's pinned-runtime/host-load gate. Interrupted, duplicate, mixed
packaging, or profiler samples fail validation. The capture/update command checks host load around
measurement. Keep the raw artifact with any externally shared result.
