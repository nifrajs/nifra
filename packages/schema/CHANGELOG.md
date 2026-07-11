# @nifrajs/schema

## 1.4.0

### Patch Changes

- 4d25970: Add one fail-open request-observation lifecycle shared by tracing, agent telemetry, and DevTools; secured development tooling; contract-based mock responses; validator-neutral schema/route reflection; executable render and storage adapter conformance modules; optional storage pagination/signing/copy capabilities; and metadata-preserving local file storage.

## 1.3.1

## 1.3.0

### Minor Changes

- 4a4b1c4: feat: `errors` response contract on routes + typed client error bodies

  A route's `RouteSchema` may now declare `errors` — a `{ status → Standard Schema }` map of its failure modes.
  Like `response`, it's a compile-time + introspection contract (not validated at runtime, zero hot-path cost):
  the declared error bodies flow into OpenAPI as non-2xx `responses` and into the `/llms.txt` context, so
  tooling and coding agents can read the _whole_ contract, not just the happy path.

  The **typed client** now surfaces them: on a failure `Result`, `data` is the parsed error body typed from the
  route's `errors` (a union across declared statuses; `unknown` when none declared), discriminated by `ok`.
  `error` remains the normalized `{ error, issues }` summary. The **decoupled contract client**
  (`client(contract, url)`) gets the same treatment — its failure `data` is typed from the op's non-2xx
  `responses` schemas.

  **Behavior change:** on failure, `data` is now the parsed error response body (previously always `null`) — so
  `const { ok, data } = await api.orders.post(...)` gives you the typed error body in the `!ok` branch. `data`
  is still `null` only on a transport error (status `0`, no response).

## 1.2.2

## 1.2.1

## 1.2.0

## 1.1.0

### Minor Changes

- 17e57c4: feat(schema): cursor pagination — `t.paginated`, `t.pageQuery`, and cursor helpers

  `t.paginated(item)` is the response envelope schema `{ items: T[]; nextCursor: string | null }`, and
  `t.pageQuery({ maxLimit })` the request query schema `{ cursor?: string; limit?: number }` (an over-limit
  value fails validation). Runtime helpers `encodeCursor` / `decodeCursor` (opaque, URL-safe, edge-safe —
  no `Buffer`) and `paginate(rows, limit, cursorOf)` build a page from a `limit + 1` fetch. Cursor
  pagination — not OFFSET — is the production default: stable under concurrent inserts, O(1) per page.

  `t.pageQuery` coerces its `limit`: query values arrive as strings (`?limit=20` → `"20"`), so without
  coercion the integer `limit` could never validate a real request. Adds an opt-in `fromTypeBox(schema,
{ coerce })` (runs TypeBox `Value.Convert` before `Check`) that `t.pageQuery` uses — body/JSON schemas
  stay strict.

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
