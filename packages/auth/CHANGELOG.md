# @nifrajs/auth

## 3.0.0

### Minor Changes

- 99fc683: A thrown `status(...)` now costs close to what a returned one costs, and the guards throw one.

  `status(...)` is meant to be **returned** - from a `beforeHandle`, from a `derive`, from the handler. The one place a return cannot work is a helper called for effect: `requireSession(c)` decides the request is over from inside a call the handler makes, and only unwinding gets out of a half-finished handler. That is the whole remaining use of `throw`, and it now runs on the same lane as the return:

  - The lifecycle error path is synchronous again. It was `async`, so a thrown `status(...)` - which needs no `await` at all - still allocated a promise and resumed a microtask later. The `onError` hook loop moved to its own async method, so only routes that registered a hook pay for one.
  - The two remaining sites that turned a thrown `status(...)` into a `Response` before rendering it (the bare and contextless fast paths) now render it as the plain data it is, through the request's own finalizer.
  - `requireSession` / `requireUser` / `requireAuthorization` throw a `status(...)` render instead of building a `Response`. The bytes on the wire are unchanged - a 401 JSON envelope, or a 302 with a `location` - and on Node they now carry a `content-length` instead of being drained back out as a stream.

  **Behavior change:** what the guards throw is a `status(...)` render, not a `Response`. Code that catches a guard and tests `err instanceof Response` needs to stop doing that; nifra itself treats the two identically as control flow, so a guard thrown through a route behaves exactly as before.

  Measured on the Linux rig (4 server cores, 50 connections, medians of 5 x 2s; a `derive` that rejects, returning vs throwing the same `status(401, ...)`). Only within-runtime deltas are readable - the host was under other load, and the return arm is included in both columns as the control:

  | runtime | return | throw, before | throw, after |
  | ------- | ------ | ------------- | ------------ |
  | node    | 85904  | 74471         | 80136        |
  | deno    | 139477 | 85970         | 90355        |

  On Node a throw now lands within the run's own spread of a return. On Deno it does not: a throw still costs ~35%, and it costs the same whether the thrown value is a `status(...)` render or a `Response` - so what remains there is the unwind itself, not the rendering.

  That remainder is the runtime's, not the framework's. The same arms with no framework at all - a bare `Deno.serve` / `Bun.serve` / `node:http` handler answering identical bytes, one returning its payload and one throwing it - reproduce it, in CPU-microseconds per request:

  |      | return | throw | throw across await |
  | ---- | ------ | ----- | ------------------ |
  | node | 49.35  | +3.85 | +2.85              |
  | bun  | 22.55  | +1.83 | +3.99              |
  | deno | 18.89  | +7.62 | +11.03             |

  Against that, nifra's own rejection arms cost +3.35 (node), +3.41 (bun), +15.59 (deno). On node and bun the framework's entire remaining throw penalty _is_ the runtime's throw. On deno the runtime's throw-across-await alone accounts for ~70% of it, and the percentage reads worse than the others only because deno's baseline request is the cheapest of the three. Two candidate explanations were tested and ruled out: `Error.stackTraceLimit = 0` changes nothing (so it is not stack capture), and throwing three frames below the handler is no cheaper (so it is not proximity to the runtime boundary).

### Patch Changes

- f0fd370: The same-origin check behind `redirect()` and the guards' `redirectTo` now rejects the paths a URL parser resolves onto another origin, and lives in one place.

  A leading `/` that is not `//` is not sufficient to keep a destination on this origin. Under a special scheme a backslash parses as a path separator, and tab, CR and LF are stripped from the input before parsing, so `/\evil.example` and `/<TAB>/evil.example` both pass a `//` test and then resolve to the host `evil.example` - an open redirect reachable from any unvalidated `?next=` parameter. Both forms are now refused: `redirect()` throws as it already did for `//host`, and an auth guard falls back to its configured destination instead of honouring the value.

  New export `isSameOriginPath` from `@nifrajs/core/server`, which is the single implementation the three gates now share - a security predicate kept in three copies is three chances for one of them to be hardened alone. It answers about a path, so an absolute URL is false even when it names the current origin: the point of the gate is that the value never got to name a host at all.

  A percent-encoded backslash (`/%5Cevil.example`) is still a same-origin path, because that is what it resolves to.

- Updated dependencies [f3d2a35]
- Updated dependencies [6e43c15]
- Updated dependencies [f0fd370]
- Updated dependencies [86a555b]
- Updated dependencies [8c5f4cf]
- Updated dependencies [f0fd370]
- Updated dependencies [381bbf3]
- Updated dependencies [36801ae]
- Updated dependencies [9acadba]
- Updated dependencies [99fc683]
- Updated dependencies [73d894d]
  - @nifrajs/core@3.0.0

## 2.14.1

## 2.14.0

## 2.13.0

## 2.12.1

## 2.12.0

### Minor Changes

- dbc0b79: Signing-secret rotation. `signValue`/`unsignValue` (and the new `CookieSecret` type), session `secret`, and CSRF `secret` now also accept a rotation list: the first secret signs, any listed secret verifies, so keys rotate without invalidating live cookies, sessions, or CSRF tokens. Every listed secret must meet the 32-byte floor and an empty list throws; the single-secret path is unchanged.

### Patch Changes

- 023891a: `destroy(c)` called without a `Session` object now revokes the stored record addressed by the request's
  signed session cookie, instead of only clearing the cookie. A logout handler that had not first loaded
  the session cleared the browser's copy while the server-side record stayed valid for its full TTL, so a
  copy of the cookie taken before logout still authenticated. The id comes from the signed cookie, so
  only a session the caller actually presented can be deleted.

## 2.11.0

## 2.10.0

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

### Patch Changes

- ade0c7a: Add a curated `@nifrajs/core/server` entry for the common HTTP runtime and dedicated subpaths for
  contracts, classification, cookies, logging, routing, Standard Schema, SEO, SSE, and webhooks. The
  package root remains backwards compatible, while new scaffolds and first-party runtime packages avoid
  eagerly parsing opt-in causality, invariant, manifest, reflection, capability, and assurance tooling.
- Updated dependencies [a7b1d60]
- Updated dependencies [eaac3d7]
- Updated dependencies [ade0c7a]
- Updated dependencies [82676e0]
- Updated dependencies [1522d06]
- Updated dependencies [a7b1d60]
- Updated dependencies [a7b1d60]
  - @nifrajs/core@2.0.0

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

### Patch Changes

- Updated dependencies [f1f0e18]
- Updated dependencies [3efb7cd]
- Updated dependencies [de9675b]
  - @nifrajs/core@1.0.0

## 1.0.0-beta.4

### Patch Changes

- @nifrajs/core@1.0.0-beta.4

## 1.0.0-beta.3

### Patch Changes

- @nifrajs/core@1.0.0-beta.3

## 0.1.0-beta.2

### Patch Changes

- @nifrajs/core@0.1.0-beta.2
