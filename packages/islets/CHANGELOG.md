# @nifrajs/islets

## 5.3.0

### Patch Changes

- @nifrajs/island-trigger@5.3.0

## 5.2.1

### Patch Changes

- @nifrajs/island-trigger@5.2.1

## 5.2.0

### Patch Changes

- 9498cf8: The package ships its `CHANGELOG.md`, so the installed package has the notes for every version, as the GitHub release does. Before, the tarball held only the code, `README.md`, `LICENSE` and `package.json`.
- Updated dependencies [9498cf8]
  - @nifrajs/island-trigger@5.2.0

## 5.1.0

### Patch Changes

- Updated dependencies [abb4354]
  - @nifrajs/island-trigger@5.1.0

## 5.0.0

### Minor Changes

- 28234dd: `computed(fn)` runs `fn` on first read instead of at creation, and stops by itself once nothing reads it: the next change to its inputs unsubscribes it instead of recomputing, so a dropped computed no longer recomputes on every write. Reading it again computes it afresh. It returns a `Computed<T>` reader whose `.dispose()` stops it at once. A malformed `data-island-state` attribute is reported with the same console message as one that is not a JSON object.
- 46b269a: Unmounting an island through the disposer `mountIslands` returns now stops every `effect` and `computed` that island's setup and bindings created, so mounting and unmounting an island repeatedly leaves nothing subscribed to a longer-lived signal.

### Patch Changes

- 81575dd: An island state key or a binding name that matches an `Object.prototype` member, such as `constructor` or `__proto__`, now names its own signal or handler. Before, it resolved to the inherited value.
- 7775c2b: Dispose island event listeners and release mounted hosts so the same DOM can safely remount.

  Ignore stale session reads after sign-out, unmount, or replacement of the auth client or loader seed.
  A new auth client object keeps the session already shown, and a completed sign-out stays signed out.

  Allow concurrent web assurance evidence reads while rejecting recursive mount cycles. Read mounted
  in-process backend evidence for generated application guidance, preserving mount prefixes and
  keeping loader-only backends out of the published route list. Generate callable paths for reserved
  typed-client segments and keep declared DELETE bodies in call options.

- Updated dependencies [46b269a]
  - @nifrajs/island-trigger@5.0.0

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
