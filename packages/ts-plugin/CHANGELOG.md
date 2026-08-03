# @nifrajs/ts-plugin

## 2.7.1

### Patch Changes

- Updated dependencies [52c89e0]
  - @nifrajs/core@2.7.1
  - @nifrajs/web@2.7.1

## 2.7.0

### Patch Changes

- @nifrajs/core@2.7.0
- @nifrajs/web@2.7.0

## 2.6.1

### Patch Changes

- Updated dependencies [5840c98]
- Updated dependencies [80419f5]
  - @nifrajs/core@2.6.1
  - @nifrajs/web@2.6.1

## 2.6.0

### Patch Changes

- Updated dependencies [e6349e5]
- Updated dependencies [08fe221]
- Updated dependencies [8383063]
  - @nifrajs/web@2.6.0
  - @nifrajs/core@2.6.0

## 2.5.0

### Patch Changes

- Updated dependencies [02d9aa8]
  - @nifrajs/web@2.5.0
  - @nifrajs/core@2.5.0

## 2.4.0

### Minor Changes

- 00cfd0e: New package: a TypeScript language-service plugin. Go-to-definition on a route-path string literal jumps to the `routes/` file that serves it.

  Put your cursor on `"/orders"` in `navigate({ to: "/orders" })`, `<Link to="/orders">`, or `href="/orders"`, and jump straight to the file. The routing is nifra's own - routes discovered with `@nifrajs/web`, matched with `@nifrajs/core`'s pattern matcher - so a path resolves to exactly the file it would serve at runtime, dynamic segments included (`/users/42` → `routes/users/[id].tsx`). Enable it with `{ "compilerOptions": { "plugins": [{ "name": "@nifrajs/ts-plugin" }] } }`.

### Patch Changes

- 1c2bf5a: Go-to-definition on a route path now resolves to the most specific route, matching how the app routes at runtime: a static segment wins over a dynamic one, so `/users/new` jumps to `routes/users/new.tsx` rather than `routes/users/[id].tsx`, regardless of the order routes were discovered. The plugin also ships a CommonJS type entry, so editors that resolve its types through `require` see the correct factory shape.
- Updated dependencies [1c2bf5a]
- Updated dependencies [138bfba]
- Updated dependencies [23e6eb1]
  - @nifrajs/web@2.4.0
  - @nifrajs/core@2.4.0
