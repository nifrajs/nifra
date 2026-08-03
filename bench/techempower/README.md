# nifra - TechEmpower Framework Benchmarks implementation

Staging copy of nifra's [TFB](https://github.com/TechEmpower/FrameworkBenchmarks) entry. The
upstream PR copies this directory to `frameworks/TypeScript/nifra/` in their repo.

## What it implements

All six required test types (JSON serialization, plaintext, single query, multiple queries,
fortunes, updates) against the TFB Postgres database, using Bun's built-in Postgres client (no ORM,
no driver dependency) and nifra's public routing exactly as an application would use it -
classification Realistic/Fullstack, not a stripped-down micro entry.

## Local smoke (no database)

From the repo root:

```bash
bun bench/techempower/src/server.ts
```

`/json` and `/plaintext` answer without a database; the four DB tests need the TFB Postgres schema
(`hello_world` with `world` and `fortune` tables).

## Full verification (TFB toolset)

```bash
git clone https://github.com/TechEmpower/FrameworkBenchmarks tfb && cd tfb
mkdir -p frameworks/TypeScript/nifra
cp -r <nifra-repo>/bench/techempower/* frameworks/TypeScript/nifra/
./tfb --mode verify --test nifra
```

The verifier checks response bodies, headers (Server + Date), the queries clamp (1..500), fortunes
HTML escaping and ordering, and that updates actually persist. All of those rules are implemented
in `src/server.ts` with comments pointing at the rule they satisfy.

## Versioning

`package.json` pins the released `@nifrajs/core`; bump it alongside framework releases so TFB
rounds measure the current release. The upstream PR should state the pinned version in its
description.
