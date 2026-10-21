# HTTP memory footprint

Build the workspace packages first, then capture the same authenticated GET/POST workload used by
the HTTP suite. Nifra, Fastify, Elysia, Hono, and Express all run as native Node modules, with the same
runtime and load settings:

```sh
bun run --filter '@nifrajs/core' --filter '@nifrajs/node' --filter '@nifrajs/middleware' build
bun run bench:memory
```

Each framework gets five fresh processes. Each process is correctness-probed, sampled after
readiness, driven through 50,000 GETs and 50,000 POSTs at 50 connections, then sampled after each
phase. All requests must complete with HTTP 200. Two forced collections precede each snapshot.
The framework order rotates between process rounds. Artifacts must stay unchanged during capture.

The output is `bench/profiling/results/realworld-memory.json` (ignored). RSS is the whole resident
process footprint, including Node and native allocations. Heap usage is retained JS memory. Peak
RSS is the OS high-water mark since startup. These are not allocation counts or a leak test.

The website table stores medians and the observed post-POST RSS range. It labels the runtime,
hardware, packaging, workload, and sample count. Nifra uses the workspace build; the peer package
versions come from the installed manifests. This protocol currently covers Node only.

To capture and update the local website dataset together:

```sh
bun run bench:memory:update
```

Or publish a previously captured local artifact into that dataset:

```sh
bun bench/memory/publish.ts bench/profiling/results/realworld-memory.json
```

Publishing here updates local source data; it does not deploy a website. It requires a complete
native-module matrix, at least three fresh processes per framework, at least 20,000 requests per
phase, and the repository's existing pinned-runtime/host-load gate. Interrupted, duplicate, mixed
packaging, or profiler samples fail validation. The capture/update command checks host load before
and after measurement. Keep the raw artifact with any externally shared result.
