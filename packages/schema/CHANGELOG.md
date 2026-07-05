# @nifrajs/schema

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
