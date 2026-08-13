# @nifrajs/ts-plugin

## 2.12.1

### Patch Changes

- Updated dependencies [fba30c7]
  - @nifrajs/core@2.12.1
  - @nifrajs/web@2.12.1

## 2.12.0

### Patch Changes

- Updated dependencies [df100d3]
- Updated dependencies [0efacea]
- Updated dependencies [cd1732c]
- Updated dependencies [df100d3]
- Updated dependencies [9a9346e]
- Updated dependencies [b5f47c0]
- Updated dependencies [fc33c0f]
- Updated dependencies [fa51aba]
- Updated dependencies [c4e8bb0]
- Updated dependencies [11d1658]
- Updated dependencies [33ee9ff]
- Updated dependencies [5f71c23]
- Updated dependencies [3788b36]
- Updated dependencies [0863ef0]
- Updated dependencies [ae5338f]
- Updated dependencies [8847825]
- Updated dependencies [9a9346e]
- Updated dependencies [4c2123d]
- Updated dependencies [5e4e31a]
- Updated dependencies [24f1787]
- Updated dependencies [9a9346e]
- Updated dependencies [b045f9e]
- Updated dependencies [df07059]
- Updated dependencies [9a9346e]
- Updated dependencies [9a9346e]
- Updated dependencies [dbc0b79]
- Updated dependencies [bd5c624]
- Updated dependencies [a5d3f5b]
- Updated dependencies [00819c5]
- Updated dependencies [e2bdd4a]
- Updated dependencies [e2d1939]
- Updated dependencies [e83e6eb]
- Updated dependencies [64d25db]
- Updated dependencies [c55f7a3]
- Updated dependencies [f8b0097]
  - @nifrajs/core@2.12.0
  - @nifrajs/web@2.12.0

## 2.11.0

### Patch Changes

- Updated dependencies [ed5e91c]
- Updated dependencies [30f5ea3]
- Updated dependencies [c29e0d0]
  - @nifrajs/web@2.11.0
  - @nifrajs/core@2.11.0

## 2.10.0

### Patch Changes

- Updated dependencies [5263c4e]
- Updated dependencies [15bffdd]
- Updated dependencies [15bffdd]
- Updated dependencies [15bffdd]
  - @nifrajs/web@2.10.0
  - @nifrajs/core@2.10.0

## 2.9.1

### Patch Changes

- Updated dependencies [01e36fb]
  - @nifrajs/core@2.9.1
  - @nifrajs/web@2.9.1

## 2.9.0

### Patch Changes

- Updated dependencies [e05e56d]
  - @nifrajs/core@2.9.0
  - @nifrajs/web@2.9.0

## 2.8.2

### Patch Changes

- Updated dependencies [f7d68e8]
  - @nifrajs/core@2.8.2
  - @nifrajs/web@2.8.2

## 2.8.1

### Patch Changes

- Updated dependencies [78d66a4]
- Updated dependencies [93fdc89]
  - @nifrajs/core@2.8.1
  - @nifrajs/web@2.8.1

## 2.8.0

### Patch Changes

- Updated dependencies [118e4a5]
  - @nifrajs/web@2.8.0
  - @nifrajs/core@2.8.0

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
