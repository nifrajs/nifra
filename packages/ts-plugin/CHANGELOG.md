# @nifrajs/ts-plugin

## 4.0.0

### Minor Changes

- d50f73e: feat(ts-plugin): the frontend/backend zone rules as editor errors

  A value import the build would refuse is an error on the import itself: backend code or a route's
  backend half in a page or under `frontend/`, frontend code under `backend/`, anything but shared code
  under `shared/`, and a Node or Bun built-in, a server package or `@nifrajs/web/backend-only` in browser
  code. `import type` is always allowed, and files in no zone (tests, scripts, config) are not checked.
  The rules are `@nifrajs/web/zones`, the classifier the builds and `nifra check` use.

### Patch Changes

- Updated dependencies [dde125b]
- Updated dependencies [22e2af8]
- Updated dependencies [72b62fa]
- Updated dependencies [aa44e93]
- Updated dependencies [4a3ee60]
- Updated dependencies [963694f]
- Updated dependencies [aad6297]
- Updated dependencies [dad0d41]
- Updated dependencies [538adc2]
- Updated dependencies [f47edd1]
- Updated dependencies [df9530a]
- Updated dependencies [3e6973f]
- Updated dependencies [25e8edf]
- Updated dependencies [2b5e5fc]
- Updated dependencies [3b090de]
- Updated dependencies [da7d792]
- Updated dependencies [612a296]
- Updated dependencies [fb14dfa]
- Updated dependencies [8ae97f6]
- Updated dependencies [4af6f39]
- Updated dependencies [ca8b50d]
- Updated dependencies [b00a889]
- Updated dependencies [b53d64f]
- Updated dependencies [66fd712]
- Updated dependencies [9c3d524]
- Updated dependencies [738e7a1]
- Updated dependencies [4801cac]
- Updated dependencies [1b2d53a]
- Updated dependencies [25fe13d]
- Updated dependencies [0852290]
- Updated dependencies [0589dbe]
- Updated dependencies [2e2d8c0]
- Updated dependencies [856f5ce]
- Updated dependencies [18aa5aa]
- Updated dependencies [cfd86b3]
- Updated dependencies [8ff96c9]
- Updated dependencies [4c46199]
- Updated dependencies [eef4932]
- Updated dependencies [6de8686]
- Updated dependencies [a0cfffa]
- Updated dependencies [d7892ea]
- Updated dependencies [93e5e7f]
- Updated dependencies [214d674]
- Updated dependencies [4936309]
- Updated dependencies [ff5a779]
- Updated dependencies [4936309]
- Updated dependencies [0e9b167]
- Updated dependencies [bbdc5a1]
- Updated dependencies [10bc446]
- Updated dependencies [e8270d9]
- Updated dependencies [d942c33]
- Updated dependencies [ef28ef9]
- Updated dependencies [ff4a062]
- Updated dependencies [43ba944]
- Updated dependencies [46c741a]
- Updated dependencies [7bfa25e]
- Updated dependencies [216fe27]
- Updated dependencies [4936309]
- Updated dependencies [6e257a6]
- Updated dependencies [4a03d30]
- Updated dependencies [8e30090]
- Updated dependencies [28f3aaf]
- Updated dependencies [6d20355]
- Updated dependencies [08250bf]
- Updated dependencies [6907cbe]
- Updated dependencies [4b8d8de]
- Updated dependencies [ba5dd1c]
- Updated dependencies [d50f73e]
- Updated dependencies [085e852]
- Updated dependencies [b64c3ee]
- Updated dependencies [dc2d4d3]
- Updated dependencies [bda9637]
- Updated dependencies [81c720e]
- Updated dependencies [ed60b23]
- Updated dependencies [0150ed4]
- Updated dependencies [ae815ab]
- Updated dependencies [ea2ee87]
- Updated dependencies [3442e1c]
- Updated dependencies [85d636b]
- Updated dependencies [6c978a1]
- Updated dependencies [bfe29b6]
- Updated dependencies [8b99424]
- Updated dependencies [87783f0]
- Updated dependencies [135aba4]
- Updated dependencies [47b0d65]
- Updated dependencies [e32268d]
- Updated dependencies [432fec3]
- Updated dependencies [0e14068]
- Updated dependencies [8f1b780]
- Updated dependencies [dcc9ff6]
- Updated dependencies [5a63dd4]
- Updated dependencies [c49882f]
- Updated dependencies [dfd19d8]
- Updated dependencies [28e091f]
- Updated dependencies [046e79d]
- Updated dependencies [6393b1e]
- Updated dependencies [a158b74]
- Updated dependencies [ee19d29]
- Updated dependencies [293d3c8]
- Updated dependencies [7e1e1c3]
- Updated dependencies [0cd5f6e]
- Updated dependencies [2245bee]
- Updated dependencies [feeec4a]
- Updated dependencies [3eb6339]
- Updated dependencies [f784c32]
- Updated dependencies [e3b2b97]
- Updated dependencies [5934b5d]
- Updated dependencies [03a3729]
- Updated dependencies [bd11269]
- Updated dependencies [579d9a9]
- Updated dependencies [3554ad8]
- Updated dependencies [64e7a42]
- Updated dependencies [ee19d29]
- Updated dependencies [d6f806f]
- Updated dependencies [38cf032]
- Updated dependencies [b94e5cb]
- Updated dependencies [0f6babe]
- Updated dependencies [00f18bf]
- Updated dependencies [a84f546]
- Updated dependencies [ff25d68]
  - @nifrajs/core@4.0.0
  - @nifrajs/web@4.0.0

## 3.5.0

### Patch Changes

- Updated dependencies [6046984]
- Updated dependencies [ac27343]
- Updated dependencies [d5b7c22]
  - @nifrajs/core@3.5.0
  - @nifrajs/web@3.5.0

## 3.4.0

### Patch Changes

- Updated dependencies [8d23613]
- Updated dependencies [8d23613]
- Updated dependencies
- Updated dependencies [719d82e]
  - @nifrajs/web@3.4.0
  - @nifrajs/core@3.4.0

## 3.3.0

### Patch Changes

- @nifrajs/core@3.3.0
- @nifrajs/web@3.3.0

## 3.2.0

### Patch Changes

- 4c81384: Harden Windows Bun dev re-exec entry detection and TypeScript route navigation across short/long path aliases.
- 469b998: Fix Windows path handling in the TypeScript route plugin and Svelte/Vue build plugins, including file-URL inputs, virtual stylesheet modules, and platform-neutral generated output.
- Updated dependencies [652201a]
- Updated dependencies [3aefb12]
- Updated dependencies [8b58d1f]
- Updated dependencies [c4ed8f7]
- Updated dependencies [25305bb]
- Updated dependencies [095c320]
- Updated dependencies [7504864]
- Updated dependencies [e88c23a]
- Updated dependencies [c39712e]
- Updated dependencies [9010fd3]
- Updated dependencies [7551709]
- Updated dependencies [ea2356e]
- Updated dependencies [a816b87]
  - @nifrajs/web@3.2.0
  - @nifrajs/core@3.2.0

## 3.1.0

### Patch Changes

- Updated dependencies [5b78473]
- Updated dependencies [1400f6c]
- Updated dependencies [8b136ee]
- Updated dependencies [a7db515]
  - @nifrajs/core@3.1.0
  - @nifrajs/web@3.1.0

## 3.0.0

### Patch Changes

- Updated dependencies [f3d2a35]
- Updated dependencies [6e43c15]
- Updated dependencies [293a7fe]
- Updated dependencies [485ae60]
- Updated dependencies [627b0ba]
- Updated dependencies [f0fd370]
- Updated dependencies [004deee]
- Updated dependencies [86a555b]
- Updated dependencies [8c5f4cf]
- Updated dependencies [f0fd370]
- Updated dependencies [381bbf3]
- Updated dependencies [36801ae]
- Updated dependencies [9acadba]
- Updated dependencies [99fc683]
- Updated dependencies [73d894d]
  - @nifrajs/core@3.0.0
  - @nifrajs/web@3.0.0

## 2.14.1

### Patch Changes

- Updated dependencies [bf93902]
  - @nifrajs/core@2.14.1
  - @nifrajs/web@2.14.1

## 2.14.0

### Patch Changes

- Updated dependencies [489c6b6]
- Updated dependencies [701961a]
- Updated dependencies [62e22e2]
- Updated dependencies [62e22e2]
- Updated dependencies [62133bf]
- Updated dependencies [8dffdf4]
- Updated dependencies [489c6b6]
  - @nifrajs/web@2.14.0
  - @nifrajs/core@2.14.0

## 2.13.0

### Patch Changes

- Updated dependencies [e0b2dd6]
- Updated dependencies [7535ce1]
- Updated dependencies [1704308]
- Updated dependencies [6510fdc]
  - @nifrajs/core@2.13.0
  - @nifrajs/web@2.13.0

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
