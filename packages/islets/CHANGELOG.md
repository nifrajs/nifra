# @nifrajs/islets

## 4.0.2

### Patch Changes

- @nifrajs/island-trigger@4.0.2

## 4.0.1

### Patch Changes

- @nifrajs/island-trigger@4.0.1

## 4.0.0

### Minor Changes

- cf58c07: `data-island-ignore` marks a subtree the island runtime leaves alone: no `data-bind-*` attribute inside it binds, and no `data-island` inside it mounts. Render user-supplied HTML there, so markup that kept its `data-*` attributes through a sanitizer cannot reach the island's handlers or signals. The full-feature island bundle stays under 2 KB gzipped.

### Patch Changes

- e1fd199: `data-bind-attr` never binds an `on*` event-handler attribute or `srcdoc`, and a URL attribute (`href`, `src`, `action`, `formaction` and the like) is set only to an http(s), mailto, tel or relative URL; any other value removes it. Markup that names one of those is skipped with a one-time warning.
- af93edf: Islands may nest: a binding belongs to its nearest island, so an outer island no longer binds the markup inside a nested island (which then followed the outer island's signals and handlers). The nested host element itself stays the outer island's markup and can still be bound by it.
  - @nifrajs/island-trigger@4.0.0

## 3.5.0

### Patch Changes

- @nifrajs/island-trigger@3.5.0

## 3.4.0

### Patch Changes

- @nifrajs/island-trigger@3.4.0

## 3.3.0

### Patch Changes

- @nifrajs/island-trigger@3.3.0

## 3.2.0

### Patch Changes

- @nifrajs/island-trigger@3.2.0

## 3.1.0

### Patch Changes

- @nifrajs/island-trigger@3.1.0

## 3.0.0

### Patch Changes

- 86a555b: The roadmap contract surfaces are now shipped across the public packages: shared island triggers,
  typed content indexes and joins, client loader/action hooks, and unified static, dynamic, and
  intercepting boundary modes. WebSocket routes also support opt-in synchronous outbound validation
  through `sendSchema` + `validateSend`; invalid or asynchronous outbound frames fail closed while the
  default remains type-level only.
- Updated dependencies [86a555b]
  - @nifrajs/island-trigger@3.0.0

## 2.14.1

## 2.14.0

## 2.13.0

## 2.12.1

## 2.12.0

## 2.11.0

## 2.10.0

## 2.9.1

## 2.9.0

## 2.8.2

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

## 1.0.0-beta.4

## 1.0.0-beta.3

## 0.1.0-beta.2
