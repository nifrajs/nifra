# @nifrajs/budget

## 1.12.0

### Patch Changes

- Updated dependencies [63d3845]
- Updated dependencies [246f498]
  - @nifrajs/core@1.12.0

## 1.11.0

### Patch Changes

- Updated dependencies [2dde7e5]
- Updated dependencies [279f80c]
- Updated dependencies [5638ada]
- Updated dependencies [279f80c]
  - @nifrajs/core@1.11.0

## 1.10.0

### Patch Changes

- 92181be: Move request-deadline mechanics to the dependency-free `@nifrajs/core/budget` subpath while keeping
  `@nifrajs/budget` as a compatible re-export. Harden adaptive admission across ESM runtimes, reserved
  capacity, disconnected queued requests, and invalid capacity evidence.
- Updated dependencies [92181be]
- Updated dependencies [3773f0a]
- Updated dependencies [92181be]
  - @nifrajs/core@1.10.0

## 1.9.1

## 1.9.0

### Minor Changes

- 03cd76f: Add portable absolute request deadlines with monotonic remaining time, child reserves, strict wire
  parsing, and local-policy admission. Nifra handlers now receive the admitted budget as `c.budget`; it
  shares the existing `c.signal`, clamps hostile far-future deadlines, and distinguishes malformed,
  expired, and exhausted inherited deadlines.

### Patch Changes

- 03cd76f: Compile eligible Nifra routes into Bun's native route table while preserving the existing lifecycle
  and portable-router fallback. Reuse unbounded request state, avoid wall-clock admission work when no
  deadline exists, lazily parse native-route queries, and inspect only captured parameter values.
  Inbound wire deadlines are now an explicit trust-boundary opt-in, keeping ordinary public routes on
  the zero-admission fast path while preserving clamped, fail-closed propagation for participating
  services.
